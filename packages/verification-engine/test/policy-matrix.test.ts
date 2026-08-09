import { describe, expect, test } from 'vitest';

import { GateRegistry } from '../src/gates/registry.js';
import {
  GATE_IDS,
  requiredGates,
  type GateRequirementClass,
} from '../src/policy-matrix.js';

const matrix: Record<string, readonly GateRequirementClass[]> = {
  dev_server_start: ['required', 'required', 'required'],
  production_build: ['best_effort', 'required', 'required'],
  typecheck: ['if_available', 'required_or_explicit_waiver', 'required_or_explicit_waiver'],
  lint: ['if_available', 'project_policy', 'project_policy'],
  unit_tests: ['existing_only', 'required_for_critical_logic', 'required'],
  integration_tests: ['existing_only', 'as_applicable', 'required_for_managed_integrations'],
  browser_smoke: ['required', 'required', 'required'],
  browser_acceptance: ['optional', 'required', 'required'],
  authorization_tests: ['optional', 'if_applicable', 'required_for_managed_auth'],
  migration_validation: ['no', 'if_applicable', 'required'],
  secret_scan: ['required', 'required', 'required'],
  dependency_scan: ['advisory', 'required_policy', 'required_policy'],
  preview_health: ['required', 'required', 'required'],
  rollback_readiness: ['no', 'required_for_code', 'required_for_supported_release_state'],
  observability_check: ['no', 'recommended', 'required'],
};

describe('PRD 24.2 gate policy matrix', () => {
  test.each([
    ['compatible', 0],
    ['verified', 1],
    ['managed', 2],
  ] as const)('matches every %s requirement class', (level, index) => {
    const requirements = requiredGates(level, { waivers: [] });

    expect(requirements).toHaveLength(15);
    expect(
      Object.fromEntries(requirements.map((requirement) => [requirement.gateId, requirement.class])),
    ).toEqual(
      Object.fromEntries(GATE_IDS.map((gateId) => [gateId, matrix[gateId]?.[index]])),
    );
  });

  test('applies only an explicit, actor-attributed waiver to a waivable gate', () => {
    const waiver = {
      gateId: 'typecheck' as const,
      actorId: 'user_01K1J6G0V8ZQ5Y7J3X9M2N4P6R',
      reason: 'Legacy generated types are tracked by migration ticket MIG-42.',
      createdAt: '2026-08-09T17:00:00.000Z',
    };
    const typecheck = requiredGates('verified', { waivers: [waiver] }).find(
      (requirement) => requirement.gateId === 'typecheck',
    );

    expect(typecheck).toEqual({
      gateId: 'typecheck',
      class: 'required_or_explicit_waiver',
      disposition: 'waived',
      waiver,
    });
    expect(() =>
      requiredGates('verified', {
        waivers: [{ ...waiver, gateId: 'secret_scan' }],
      }),
    ).toThrow('gate_not_waivable');
  });

  test('registers every gate once and rejects duplicate ids', () => {
    const registry = new GateRegistry();
    const gate = {
      id: 'secret_scan' as const,
      run: () =>
        Promise.resolve({ status: 'passed' as const, evidenceArtifactIds: [], details: {} }),
    };

    registry.register(gate);
    expect(registry.get('secret_scan')).toBe(gate);
    expect(() => {
      registry.register(gate);
    }).toThrow('gate_already_registered');
  });
});
