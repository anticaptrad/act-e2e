import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/atto/candidate-boundaries.v1.json", import.meta.url),
  "utf8",
));

function classifyHttp(status) {
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "redirect";
  return "error";
}

function clipDurationAllowed(durationMs) {
  return durationMs >= 30000 && durationMs <= 50000;
}

function candidateErrors(document) {
  const errors = [];
  const check = (ok, label) => { if (!ok) errors.push(label); };
  check(document.schema === "anticaptrad.atto-candidate-boundary/v1", "schema identity");
  check(document.status === "candidate", "promotion not authorized");
  check(document.compilerExecuted === false && document.admissionProof === false, "no compiler receipt");
  const profiles = document.profiles ?? [];
  check(profiles.length === 2, "two candidate profiles required");
  for (const profile of profiles) {
    check(/^[a-f0-9]{40}$/.test(profile.sourceBlobSha ?? ""), "immutable source blob SHA");
    check(profile.source?.endsWith(".atto"), "Atto source path");
    check(profile.repository === "anticaptrad/act-clients" || profile.repository === "anticaptrad/act-interfaces", "approved source repo");
    check(profile.pullRequest === `https://github.com/${profile.repository}/pull/${profile.id === "public-http-status" ? 26 : 18}`, "PR provenance");
    const evaluate = profile.id === "public-http-status" ? classifyHttp
      : profile.id === "creator-clip-duration" ? clipDurationAllowed
      : null;
    check(evaluate !== null, "unexpected profile");
    for (const item of profile.cases ?? []) {
      check(Number.isInteger(item.input), "integer boundary");
      if (evaluate !== null) check(evaluate(item.input) === item.expected, "boundary mismatch");
    }
    const expectedEdges = profile.id === "public-http-status" ? [199, 200, 299, 300, 399, 400]
      : [29999, 30000, 50000, 50001];
    check(
      expectedEdges.every((n) => profile.cases?.some((item) => item.input === n)),
      "missing required boundary case",
    );
  }
  return errors;
}

test("candidate cases cover contract boundary transitions without claiming compiler proof", () => {
  assert.deepEqual(candidateErrors(fixture), []);
});

test("negative canaries reject forged admission, altered boundaries and invalid provenance", () => {
  const mutate = (callback) => {
    const copy = structuredClone(fixture);
    callback(copy);
    assert.notDeepEqual(candidateErrors(copy), []);
  };
  mutate((doc) => { doc.compilerExecuted = true; });
  mutate((doc) => { doc.status = "production"; });
  mutate((doc) => { doc.profiles[0].cases[1].expected = "redirect"; });
  mutate((doc) => { doc.profiles[1].cases[1].expected = false; });
  mutate((doc) => { doc.profiles[1].sourceBlobSha = "moving-main"; });
  mutate((doc) => { doc.profiles[0].cases.pop(); });
});
