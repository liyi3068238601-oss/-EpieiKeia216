import type { ContextPacket, ContextPacketInput } from "../../contracts/src/index.js";

declare const input: ContextPacketInput;
declare const packet: ContextPacket;

if (false) {
  // @ts-expect-error The builder input has no caller-controlled instruction partition.
  input.instruction;
  // @ts-expect-error Contract inputs are readonly snapshots.
  input.scope = "changed";
  // @ts-expect-error Partition arrays are readonly.
  input.content.push({ source_refs: ["memory"], value: "changed" });
  // @ts-expect-error Packet instruction entries are readonly.
  packet.instruction[0]!.text = "changed";
}
