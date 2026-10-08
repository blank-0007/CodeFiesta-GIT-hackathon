import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** Node-side MSW server used by Vitest — the same handlers as the browser. */
export const server = setupServer(...handlers);
