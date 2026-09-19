/**
 * Live smoke test for the CommunityOps console's integration contract.
 *
 * Exercises the same Cognito SRP library and the same API endpoints the browser
 * console uses, against the deployed AWS stack. This verifies that the token
 * the frontend obtains is accepted by API Gateway and that every console view
 * receives real data. It does not render the UI — it validates the integration
 * path the UI depends on.
 *
 * Usage (from apps/web):
 *   node scripts/live-smoke.mjs
 *
 * Reads configuration from the environment:
 *   VITE_API_URL, VITE_COGNITO_USER_POOL_ID, VITE_COGNITO_CLIENT_ID,
 *   VITE_ORG_ID, SMOKE_USERNAME, SMOKE_PASSWORD_FILE
 */

import { readFileSync } from "node:fs";
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} from "amazon-cognito-identity-js";

const API = process.env.VITE_API_URL;
const POOL_ID = process.env.VITE_COGNITO_USER_POOL_ID;
const CLIENT_ID = process.env.VITE_COGNITO_CLIENT_ID;
const ORG = process.env.VITE_ORG_ID || "ORG-wemakedev";
const USERNAME = process.env.SMOKE_USERNAME;
const PASSWORD = readFileSync(process.env.SMOKE_PASSWORD_FILE, "utf8").trim();
const EVENT_ID = "EVT-devcon-2026";

for (const [k, v] of Object.entries({ API, POOL_ID, CLIENT_ID, USERNAME })) {
  if (!v) {
    console.error(`Missing required configuration: ${k}`);
    process.exit(2);
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}: ${detail}`);
}

function signIn() {
  return new Promise((resolve, reject) => {
    const user = new CognitoUser({
      Username: USERNAME,
      Pool: new CognitoUserPool({ UserPoolId: POOL_ID, ClientId: CLIENT_ID }),
    });
    user.authenticateUser(
      new AuthenticationDetails({ Username: USERNAME, Password: PASSWORD }),
      {
        onSuccess: (session) => resolve(session.getIdToken().getJwtToken()),
        onFailure: (err) => reject(err),
        newPasswordRequired: () => reject(new Error("NEW_PASSWORD_REQUIRED")),
      },
    );
  });
}

async function call(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", Authorization: token },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const token = await signIn();
check("console.cognito_srp_signin", Boolean(token), `ID token acquired (${token.length} chars)`);

const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
const groups = claims["cognito:groups"] ?? [];
check(
  "console.org_membership_claim",
  Array.isArray(groups) ? groups.includes(ORG) : String(groups).includes(ORG),
  `cognito:groups contains ${ORG}`,
);

// Each entry maps to one console view.
const views = [
  ["CommandCenter", `/command-center?organization_id=${ORG}`, (b) => b.events?.length > 0],
  ["SpeakerOps", `/events/${EVENT_ID}/speakers?organization_id=${ORG}`, (b) => b.speakers?.length > 0],
  ["ApprovalCenter", `/events/${EVENT_ID}/approvals?organization_id=${ORG}`, (b) => Array.isArray(b.approvals)],
  ["IncidentCenter", `/events/${EVENT_ID}/incidents?organization_id=${ORG}`, (b) => b.incidents?.length > 0],
  ["TaskBoard", `/events/${EVENT_ID}/teams/TEAM-registration/tasks?organization_id=${ORG}`, (b) => b.tasks?.length > 0],
  ["AuditLog", `/events/${EVENT_ID}/audit?organization_id=${ORG}`, (b) => b.audit_events?.length > 0],
];

for (const [view, path, ok] of views) {
  const { status, body } = await call(token, path);
  check(`console.${view}`, status === 200 && ok(body), `HTTP ${status}`);
}

// Check-in Console: the hero workflow's first step.
const searchRes = await fetch(`${API}/events/${EVENT_ID}/checkin/search`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: token },
  body: JSON.stringify({ organization_id: ORG, email: "priya.sharma@example.com" }),
});
const searchBody = await searchRes.json();
check(
  "console.CheckinConsole_search",
  searchRes.status === 200 && searchBody.found === true,
  `HTTP ${searchRes.status}, found=${searchBody.found}`,
);

// A stale/absent token must produce an explicit error, never silent mock data.
const noAuth = await fetch(`${API}/command-center?organization_id=${ORG}`);
check(
  "console.unauthenticated_surfaces_error",
  noAuth.status === 401,
  `HTTP ${noAuth.status} (console shows an error state, not fabricated data)`,
);

const failed = results.filter((r) => !r.ok);
console.log("=".repeat(64));
console.log(`CONSOLE LIVE RESULT: ${results.length - failed.length}/${results.length} passed`);
console.log("=".repeat(64));
process.exit(failed.length === 0 ? 0 : 1);
