/** The e2e run's servers, shared by the config and the fixtures. */
export const E2E = {
  webPort: Number(process.env.E2E_WEB_PORT ?? 4427),
  relayPort: Number(process.env.E2E_RELAY_PORT ?? 4429),
  relayKey: "e2e:e2e-relay-secret",
  get webUrl() {
    return `http://localhost:${this.webPort}`;
  },
  get relayUrl() {
    return `ws://127.0.0.1:${this.relayPort}`;
  },
};
