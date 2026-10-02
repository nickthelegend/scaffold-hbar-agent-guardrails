import { NextResponse } from "next/server";
import deployedContracts from "~~/contracts/deployedContracts";
import scaffoldConfig from "~~/scaffold.config";

/** Liveness + configuration probe used by the harness smoke tests and the hosting health check. */
export function GET() {
  const network = scaffoldConfig.targetNetworks[0];
  const contracts = (deployedContracts as Record<number, Record<string, { address: string }>>)[network.id] ?? {};
  return NextResponse.json({
    ok: true,
    network: network.name,
    chainId: network.id,
    agentVaultFactory: contracts.AgentVaultFactory?.address ?? null,
  });
}
