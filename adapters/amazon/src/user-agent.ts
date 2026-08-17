/**
 * The honest agent User-Agent (spec §3A / Amazon Conditions of Use "Agent
 * Terms": agents must self-identify on EVERY request). Deliberately contains
 * NO human-browser tokens (Mozilla/Chrome/Safari/…): this agent never
 * masquerades as a person's hand on a browser. Applied at the Playwright
 * browser-context level so every request the context makes carries it.
 */
export const AGENT_USER_AGENT =
  "NorthCinderAgent/0.1 (automated shopping agent; acts only in its user's own logged-in session)";
