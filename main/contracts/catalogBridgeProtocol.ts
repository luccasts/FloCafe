import { createHmac, timingSafeEqual } from 'node:crypto';

export type CatalogMachineConfig = { installationId: string; key: string };
export type CatalogCapability = 'catalog.get_page';
export type CatalogHandshake = {
  type: 'business'; protocol: 2; phase: 'offer' | 'accept' | 'confirm';
  installationId: string; sessionId: string; nonce: string; peerNonce: string | null; capabilities: CatalogCapability[]; proof: string;
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const capabilities = (v: unknown): v is CatalogCapability[] => Array.isArray(v) && v.length <= 1 && v.every(x => x === 'catalog.get_page');
export function validCatalogMachineConfig(v: unknown): v is CatalogMachineConfig {
  return plain(v) && id(v.installationId) && hex(v.key);
}
function transcript(v: Omit<CatalogHandshake, 'proof'>): string {
  return 'polo-flo-catalog-v2\n' + JSON.stringify({ type: v.type, protocol: v.protocol, phase: v.phase, installationId: v.installationId, sessionId: v.sessionId, nonce: v.nonce, peerNonce: v.peerNonce, capabilities: v.capabilities });
}
export function signCatalogHandshake(phase: CatalogHandshake['phase'], machine: CatalogMachineConfig, sessionId: string, nonce: string, offered: readonly CatalogCapability[], peerNonce: string | null = null): CatalogHandshake {
  if (!validCatalogMachineConfig(machine) || !id(sessionId) || !hex(nonce) || !capabilities(offered) || !['offer', 'accept', 'confirm'].includes(phase) || (phase === 'offer' ? peerNonce !== null : !hex(peerNonce))) throw new Error('catalog_invalid_machine_handshake');
  const body: Omit<CatalogHandshake, 'proof'> = { type: 'business', protocol: 2, phase, installationId: machine.installationId, sessionId, nonce, peerNonce, capabilities: [...offered] };
  return { ...body, proof: createHmac('sha256', Buffer.from(machine.key, 'hex')).update(transcript(body)).digest('hex') };
}
export function validateCatalogHandshake(input: unknown, phase: CatalogHandshake['phase'], machine: CatalogMachineConfig, expected?: { sessionId: string; nonce: string; peerNonce?: string }): CatalogHandshake | null {
  if (!validCatalogMachineConfig(machine) || !plain(input) || Object.keys(input).length !== 9 || !['type','protocol','phase','installationId','sessionId','nonce','peerNonce','capabilities','proof'].every(k => Object.hasOwn(input, k))) return null;
  if (input.type !== 'business' || input.protocol !== 2 || input.phase !== phase || input.installationId !== machine.installationId || !id(input.sessionId) || !hex(input.nonce) || !capabilities(input.capabilities) || !hex(input.proof)) return null;
  if (phase === 'offer' ? input.peerNonce !== null : !hex(input.peerNonce)) return null;
  if (expected && (input.sessionId !== expected.sessionId || input.nonce !== expected.nonce || (expected.peerNonce !== undefined && input.peerNonce !== expected.peerNonce))) return null;
  const signed = signCatalogHandshake(phase, machine, input.sessionId, input.nonce, input.capabilities, input.peerNonce as string | null);
  return timingSafeEqual(Buffer.from(input.proof, 'hex'), Buffer.from(signed.proof, 'hex')) ? signed : null;
}
