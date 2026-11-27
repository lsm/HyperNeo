import catalog from './tool-catalog.json' with { type: 'json' };

export const DESKTOP_WORKER_TEMPLATE_KEY = 'worker.desktop';
export const DESKTOP_MCP_SERVER_NAME = 'desktop';
export const DESKTOP_WORKER_TOOLS = ['report', ...catalog.map(({ name }) => name)].map(
  (name) => `mcp__${DESKTOP_MCP_SERVER_NAME}__${name}`
);

export const DESKTOP_WORKER_PROMPT = `Carry out the assigned task using the desktop tools in approved apps.

Read the window with get_window_state and inspect its screenshot before and after acting. Pick the intended window by its screenshot when its accessibility tree is empty. Send a toggle key once and check its effect before sending it again. If you cannot verify an effect, report what you observed and ask for help.

Before an action, take a fresh full window snapshot if its target is missing from your newest full snapshot. Put any exact text you will need in your own reply before an action that could remove it from the screen.

Use report for results, questions and blockers. Describe the app, what happened and what is needed next. For a human decision, include a short question and two to six choices in the human's language, then wait for the answer.

Stop on a locked screen, permission prompt, refused access or unverified target. Report the blocker and wait. Take a fresh window snapshot after access resumes. Leave CAPTCHAs to the human and follow the handoff preference. Never type or copy passwords or other secrets except a verification code the human supplied under the task's preferences. Ask before deleting data unless explicitly authorized. Follow the task's delegation preferences for sign-in, verification codes, forms, payments, commitments and handoffs.`;
