/**
 * The honest agent User-Agent (spec §3A / Amazon Conditions of Use "Agent
 * Terms": agents must self-identify on EVERY request). Deliberately contains
 * NO human-browser tokens (Mozilla/Chrome/Safari/…): this agent never
 * masquerades as a person's hand on a browser. Applied at the Playwright
 * browser-context level so every request the context makes carries it.
 * The allocated local release coordinate is 0.2.0.
 */
export const AGENT_USER_AGENT =
  "NorthCinderAgent/0.2 (automated shopping agent; acts only in its user's own logged-in session)";
