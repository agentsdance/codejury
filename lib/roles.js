import { knownAgents, judgeAgent } from "./config.js";
import { probe } from "./agents.js";

// Persist names, not executable definitions: resume uses the current trusted
// configuration, but never draws new roles from a changed PATH.
export async function automaticRoles(cfg, {
  judge, reviewers, previous, check = probe, random = Math.random,
} = {}) {
  if (judge !== undefined || (reviewers !== undefined && reviewers !== null)) return null;
  if (previous) return previous.automaticRoles ?? null;
  if (cfg.explicitRoles) return null;
  const available = [];
  for (const agent of knownAgents(cfg)) {
    if (!agent.argv?.length) continue;
    if ((await check(agent)).ok && (await check(judgeAgent(cfg, agent.name))).ok) available.push(agent);
  }
  if (available.length < 1 || available.length > 2) return null;
  const selected = available.length === 1 ? 0 : Math.floor(random() * 2);
  return {
    judge: available[selected].name,
    reviewers: [available[available.length === 1 ? 0 : 1 - selected].name],
  };
}

export function automaticReviewers(cfg, roles, requested) {
  const names = requested ?? roles.reviewers;
  if (!names.length) throw new Error("--reviewer needs at least one reviewer name");
  return names.map(name => {
    if (!roles.reviewers.includes(name)) throw new Error(`reviewer "${name}" was not assigned to this run`);
    const agent = knownAgents(cfg).find(a => a.name === name);
    if (!agent) throw new Error(`saved reviewer "${name}" is not configured or is disabled`);
    // Keep the read-only reviewer argv, even when this agent is also judge.
    return agent;
  });
}
