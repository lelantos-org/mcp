// Bootstrap: connect the upstreams, price their tools, then listen.
//
// Discovery happens once, at boot, so that answering an unpaid request costs
// nothing upstream: a client that never pays can make us build offers all day
// without any of it reaching the servers we front.
//
// The one piece of judgement here is where payment goes — in chain mode the
// wallet's own address, because a note sent anywhere else is one this server
// cannot decrypt and so cannot accept.

import { createServer } from "node:http";
import type { DeployedNetworkName, ReadOnlyWalletApi } from "@lelantos-org/sdk";
import { connectWatch } from "@lelantos-org/sdk/watch";
import { privateKeyToAccount } from "viem/accounts";
import { buildCatalogue } from "./catalogue.js";
import { type Config, loadConfig } from "./config.js";
import { formatterFor, NO_DISPLAY, resolveAssets } from "./display.js";
import { createHandler, MCP_PATH } from "./http.js";
import { ConsumedLedger } from "./ledger.js";
import type { OfferContext } from "./offer.js";
import { assetsIn } from "./pricing.js";
import { transparentPayer } from "./settle.js";
import { UpstreamPool } from "./upstream.js";
import { chainVerifier, devVerifier, type Verifier } from "./verify.js";

async function main(): Promise<void> {
    const config = loadConfig();
    const ledger = await ConsumedLedger.open(config.ledgerPath);
    const network = `shielded:${config.chainId}`;
    const { verifier, payTo, watch } = await resolveVerifier(config, ledger, network);

    // Registry entries are read once, here, so that rendering a price later
    // costs nothing and an unpaid `tools/list` never reaches an RPC.
    const format = watch
        ? formatterFor(await resolveAssets(assetsIn(config.pricing), (id) => watch.asset(id)))
        : NO_DISPLAY;

    const pool = await UpstreamPool.connect(config.upstreams, upstreamPayer(config));
    const catalogue = buildCatalogue(await pool.tools(), config.pricing, format);

    const offerContext: OfferContext = {
        chainId: config.chainId,
        payTo,
        timeoutSeconds: config.timeoutSeconds,
        resourceUrl: config.publicUrl,
        serviceName: config.serviceName,
    };

    const server = createServer(createHandler({ config, catalogue, pool, verifier, offerContext }));

    server.listen(config.bind.port, config.bind.host, () => {
        console.info(
            `[mcp] listening on http://${config.bind.host}:${config.bind.port}${MCP_PATH}`,
        );
        console.info(
            `[mcp] proxying ${catalogue.size} tool(s) from ${config.upstreams.length} upstream(s); ` +
                `${ledger.size} payment(s) already consumed`,
        );
    });

    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => {
            // Stdio upstreams are child processes; leaving them behind would
            // outlive this server and keep holding whatever they had open.
            void pool.close().then(() => process.exit(0));
        });
    }
}

/** The `fetch` that settles upstream 402s, when a transparent account is configured. */
function upstreamPayer(config: Config): typeof fetch | undefined {
    const payment = config.upstreamPayment;
    if (!payment) return undefined;

    const account = privateKeyToAccount(payment.privateKey as `0x${string}`);
    const ceilings = [...payment.maxPerCall].map(([token, max]) => `${token} ≤ ${max}`);
    console.info(
        `[mcp] paying upstreams from ${account.address} on chain ${payment.chainId}, ` +
            `per call: ${ceilings.join(", ")}`,
    );
    return transparentPayer({ account, chainId: payment.chainId, maxPerCall: payment.maxPerCall });
}

async function resolveVerifier(
    config: Config,
    ledger: ConsumedLedger,
    network: string,
): Promise<{ verifier: Verifier; payTo: string; watch?: ReadOnlyWalletApi }> {
    if (config.mode.kind === "dev") {
        console.warn("[mcp] DEV MODE: payments are not verified against any chain");
        // No wallet, so no registry, so prices are published in raw units.
        return { verifier: devVerifier(ledger, network), payTo: config.mode.payTo };
    }

    const { viewingKey, rpcUrl, payTo } = config.mode;
    const watch = await connectWatch({
        viewingKey,
        // Narrowed rather than validated here: `connectWatch` rejects an unknown
        // name with an error that names it, which is a better message than
        // anything this file could produce.
        network: config.mode.network as DeployedNetworkName,
        ...(rpcUrl ? { rpcUrl } : {}),
    });
    // One sync at boot, so the first payment does not also pay for a cold scan
    // of the whole chain inside its verification window.
    await watch.sync();

    const address = payTo ?? watch.address;
    console.info(`[mcp] verifying against ${config.mode.network}, paid to ${address}`);
    return {
        verifier: chainVerifier(watch, ledger, { network, timeoutMs: config.verifyTimeoutMs }),
        payTo: address,
        watch,
    };
}

main().catch((err: unknown) => {
    console.error("[mcp] failed to start", err);
    process.exit(1);
});
