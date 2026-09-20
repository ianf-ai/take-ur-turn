/**
 * Global test setup — runs once before every test file.
 *
 * Launcher delivery/entry suites exercise the REAL escalation path: on
 * give-up they best-effort POST a delivery_giveup agent event to the
 * event-port URL resolved from the environment. With no override that is
 * the production default 127.0.0.1:3002 — on a contributor machine with a
 * live `tut notify` listening there, every `npm test` run leaks fixture
 * events (unit-1.executor, t-po, ...) into real desktop notifications.
 * Pin the port to the dead-port convention
 * (127.0.0.1:1, as launcher-fresh already uses for TUT_HUB_URL): the POST
 * fails instantly and silently, which is exactly the best-effort contract.
 *
 * Set unconditionally (not "if unset") so a developer's shell exporting a
 * live port cannot reintroduce the leak. Pure-function tests pin the
 * default via explicit env arguments and are unaffected; `up` only embeds
 * TUT_EVENT_PORT_URL into pane commands when --event-port moves the port,
 * so rendered-command assertions are unaffected too.
 */
process.env.TUT_EVENT_PORT_URL = "http://127.0.0.1:1/agent-event";

// workers inherit rig endpoints. Keep a live parent rig out of fixture
// defaults; individual routing tests set their own explicit environment.
delete process.env.TUT_HUB_URL;
delete process.env.TUT_HUB_ROOT;
