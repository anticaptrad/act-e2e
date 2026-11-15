//! Rust-only boundary vector checks; this is NOT Atto compiler execution.

const FIXTURE: &str = include_str!("../../fixtures/atto/candidate-boundaries.v1.json");

fn section<'a>(text: &'a str, id: &str) -> Option<&'a str> {
    let anchor = format!("\"id\": \"{id}\"");
    let start = text.find(&anchor)?;
    let rest = &text[start..];
    let end = rest.find("\n    }\n").or_else(|| rest.find("\n    }\r\n"))?;
    Some(&rest[..end])
}

fn field<'a>(source: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\": ");
    let line = source.lines().find(|l| l.trim_start().starts_with(&needle))?;
    Some(line.trim().strip_prefix(&needle)?.trim_end_matches(',').trim_matches('"'))
}

fn cases(section: &str) -> Option<Vec<(i64, String)>> {
    let mut inputs = Vec::new();
    let mut current = None;
    for line in section.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("\"input\": ") {
            if current.is_some() { return None; }
            current = Some(value.trim_end_matches(',').parse::<i64>().ok()?);
        }
        if let Some(value) = line.strip_prefix("\"expected\": ") {
            inputs.push((current.take()?, value.trim_end_matches(',').trim_matches('"').to_owned()));
        }
    }
    if current.is_some() { None } else { Some(inputs) }
}

fn classify(status: i64) -> &'static str {
    if (200..300).contains(&status) { "success" }
    else if (300..400).contains(&status) { "redirect" }
    else { "error" }
}

fn candidate_errors(doc: &str) -> Vec<&'static str> {
    let mut failures = Vec::new();
    let mut check = |valid: bool, message| {
        if !valid { failures.push(message); }
    };
    check(field(doc, "schema") == Some("anticaptrad.atto-candidate-boundary/v1"), "schema");
    check(field(doc, "status") == Some("candidate"), "candidate status");
    check(field(doc, "compilerExecuted") == Some("false"), "compiler unverified");
    check(field(doc, "admissionProof") == Some("false"), "admission unverified");
    for (id, repo, src, pr) in [
        ("public-http-status", "anticaptrad/act-clients",
            "language-candidates/atto/status_probe.atto",
            "https://github.com/anticaptrad/act-clients/pull/26"),
        ("creator-clip-duration", "anticaptrad/act-interfaces",
            "examples/v1/atto-clip-duration.atto",
            "https://github.com/anticaptrad/act-interfaces/pull/18"),
    ] {
        let Some(profile) = section(doc, id) else {
            check(false, "profile missing");
            continue;
        };
        check(field(profile, "repository") == Some(repo), "repository ownership");
        check(field(profile, "source") == Some(src), "source path");
        check(field(profile, "pullRequest") == Some(pr), "PR provenance");
        let sha = field(profile, "sourceBlobSha").unwrap_or("");
        check(sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()), "exact SHA");
        let actual = cases(profile);
        let expected: Vec<(i64, String)> = if id == "public-http-status" {
            [199, 200, 299, 300, 399, 400].into_iter()
                .map(|n| (n, classify(n).to_owned())).collect()
        } else {
            [29999, 30000, 50000, 50001].into_iter()
                .map(|n| (n, ((30000..=50000).contains(&n)).to_string())).collect()
        };
        check(actual == Some(expected), "boundary cases");
    }
    failures
}

#[test]
fn candidate_boundaries_match_expected_contracts() {
    assert!(candidate_errors(FIXTURE).is_empty(), "{:?}", candidate_errors(FIXTURE));
}

#[test]
fn mutations_fail_closed() {
    for (old, new) in [
        ("\"compilerExecuted\": false", "\"compilerExecuted\": true"),
        ("\"status\": \"candidate\"", "\"status\": \"production\""),
        ("\"input\": 30000", "\"input\": 30001"),
        ("\"expected\": \"redirect\"", "\"expected\": \"success\""),
        ("\"sourceBlobSha\": \"f2504c6c46199da5bb7d7bf2d5be6f55a90ae7e7\"", "\"sourceBlobSha\": \"moving-main\""),
    ] {
        let changed = FIXTURE.replacen(old, new, 1);
        assert!(!candidate_errors(&changed).is_empty(), "mutation not detected: {old}");
    }
}
