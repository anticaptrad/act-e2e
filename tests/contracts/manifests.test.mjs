// Deployment-manifest contracts.
//
// The k8s manifests in act-infra encode assumptions about the services — which
// port they listen on, which probe paths they answer, which secrets they read.
// Nothing in the build fails when an app default and its manifest drift apart,
// and the symptom in the cluster is a pod that never passes its probes.
//
// These tests read the manifests directly and check them against what the
// running services actually do. They skip when act-infra is not checked out
// alongside; point ACT_INFRA_PATH at it to run them elsewhere.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { services } from '../config.mjs';
import { get } from '../helpers/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const INFRA = process.env.ACT_INFRA_PATH ?? path.resolve(here, '../../../act-infra');
const DEPLOY_DIR = path.join(INFRA, 'deployments');

const available = fs.existsSync(DEPLOY_DIR);
const skip = available ? false : `act-infra deployments not found at ${DEPLOY_DIR}`;

/** Every parsed document across every manifest, tagged with its file. */
let docs = [];

before(() => {
  if (!available) return;
  docs = fs
    .readdirSync(DEPLOY_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .flatMap((file) => {
      const text = fs.readFileSync(path.join(DEPLOY_DIR, file), 'utf8');
      return YAML.parseAllDocuments(text)
        .map((d) => d.toJS())
        .filter(Boolean)
        .map((doc) => ({ file, doc }));
    });
});

const deployments = () => docs.filter(({ doc }) => doc.kind === 'Deployment');
const servicesOf = () => docs.filter(({ doc }) => doc.kind === 'Service');
const containersOf = (doc) => doc.spec.template.spec.containers ?? [];

describe('manifests parse and describe the expected workloads', { skip }, () => {
  test('every manifest file parses', () => {
    assert.ok(docs.length > 0, 'no manifest documents were parsed');
  });

  test('each service has a Deployment and a Service', () => {
    const deployNames = deployments().map(({ doc }) => doc.metadata.name).sort();
    const svcNames = servicesOf().map(({ doc }) => doc.metadata.name).sort();
    for (const expected of ['act-api-server', 'act-web-server', 'act-ai-server', 'act-mcp-server']) {
      assert.ok(deployNames.includes(expected), `missing Deployment for ${expected}`);
      assert.ok(svcNames.includes(expected), `missing Service for ${expected}`);
    }
  });

  test('every Service selector matches a Deployment pod label', () => {
    const podLabels = new Map(
      deployments().map(({ doc }) => [doc.metadata.name, doc.spec.template.metadata.labels]),
    );
    for (const { doc } of servicesOf()) {
      const selector = doc.spec.selector;
      const labels = podLabels.get(doc.metadata.name);
      assert.ok(labels, `Service ${doc.metadata.name} has no matching Deployment`);
      for (const [k, v] of Object.entries(selector)) {
        assert.equal(labels[k], v, `Service ${doc.metadata.name} selector ${k} does not match`);
      }
    }
  });
});

describe('workloads are production-shaped', { skip }, () => {
  test('every container declares both probes', () => {
    for (const { doc } of deployments()) {
      for (const c of containersOf(doc)) {
        assert.ok(c.livenessProbe, `${doc.metadata.name} has no livenessProbe`);
        assert.ok(c.readinessProbe, `${doc.metadata.name} has no readinessProbe`);
      }
    }
  });

  test('probes target /health and /ready', () => {
    for (const { doc } of deployments()) {
      for (const c of containersOf(doc)) {
        assert.equal(c.livenessProbe.httpGet.path, '/health', `${doc.metadata.name} liveness path`);
        assert.equal(c.readinessProbe.httpGet.path, '/ready', `${doc.metadata.name} readiness path`);
      }
    }
  });

  test('every container sets resource requests and limits', () => {
    for (const { doc } of deployments()) {
      for (const c of containersOf(doc)) {
        assert.ok(c.resources?.requests?.cpu, `${doc.metadata.name} has no cpu request`);
        assert.ok(c.resources?.requests?.memory, `${doc.metadata.name} has no memory request`);
        assert.ok(c.resources?.limits?.cpu, `${doc.metadata.name} has no cpu limit`);
        assert.ok(c.resources?.limits?.memory, `${doc.metadata.name} has no memory limit`);
      }
    }
  });

  test('containers run unprivileged with a read-only root filesystem', () => {
    for (const { doc } of deployments()) {
      assert.equal(
        doc.spec.template.spec.securityContext?.runAsNonRoot,
        true,
        `${doc.metadata.name} does not require a non-root user`,
      );
      for (const c of containersOf(doc)) {
        assert.equal(c.securityContext?.allowPrivilegeEscalation, false, doc.metadata.name);
        assert.equal(c.securityContext?.readOnlyRootFilesystem, true, doc.metadata.name);
        assert.deepEqual(c.securityContext?.capabilities?.drop, ['ALL'], doc.metadata.name);
      }
    }
  });

  test('rollouts do not drop capacity', () => {
    for (const { doc } of deployments()) {
      const strategy = doc.spec.strategy;
      if (strategy?.type === 'RollingUpdate') {
        assert.equal(
          strategy.rollingUpdate.maxUnavailable,
          0,
          `${doc.metadata.name} allows unavailable pods during a rollout`,
        );
      }
    }
  });
});

describe('secrets are injected, never baked in', { skip }, () => {
  test('no container carries an inline secret-looking literal', () => {
    const suspicious = /(secret|password|token|api[_-]?key)/i;
    for (const { doc } of deployments()) {
      for (const c of containersOf(doc)) {
        for (const env of c.env ?? []) {
          if (env.value && suspicious.test(env.name)) {
            assert.fail(`${doc.metadata.name} sets ${env.name} to a literal value`);
          }
        }
      }
    }
  });

  test('credentials arrive via secretRef', () => {
    for (const { doc } of deployments()) {
      for (const c of containersOf(doc)) {
        const hasSecretRef = (c.envFrom ?? []).some((e) => e.secretRef);
        assert.ok(hasSecretRef, `${doc.metadata.name} has no secretRef envFrom`);
      }
    }
  });

  test('no manifest still uses the mock secret loader', () => {
    // An earlier revision wrote fake secrets into a file with an init container
    // and sourced it at startup. That pattern must not come back.
    for (const { file, doc } of deployments()) {
      const initNames = (doc.spec.template.spec.initContainers ?? []).map((c) => c.name);
      assert.ok(
        !initNames.some((n) => /secrets-loader/i.test(n)),
        `${file} still uses a secrets-loader init container`,
      );
    }
  });
});

describe('manifests agree with the running services', { skip }, () => {
  test('the container port matches the port each app listens on', () => {
    // Ports are declared in three places (app default, container port, Service
    // targetPort); this pins the manifest half of that agreement.
    const expected = {
      'act-api-server': 8080,
      'act-web-server': 8080,
      'act-mcp-server': 8080,
      'act-ai-server': 3000,
    };
    for (const { doc } of deployments()) {
      const port = containersOf(doc)[0].ports[0].containerPort;
      assert.equal(port, expected[doc.metadata.name], `${doc.metadata.name} container port`);
    }
  });

  test('each Service forwards to the container port by name', () => {
    for (const { doc } of servicesOf()) {
      for (const port of doc.spec.ports) {
        assert.equal(port.targetPort, 'http', `${doc.metadata.name} should target the named port`);
      }
    }
  });

  test('the probe paths the manifests declare actually answer', async () => {
    // Closes the loop: the paths asserted above are the ones the live services
    // serve, so a renamed route cannot pass the manifest check alone.
    for (const [name, base] of Object.entries(services)) {
      for (const probePath of ['/health', '/ready']) {
        const { status } = await get(`${base}${probePath}`);
        assert.equal(status, 200, `${name}${probePath} did not answer`);
      }
    }
  });
});
