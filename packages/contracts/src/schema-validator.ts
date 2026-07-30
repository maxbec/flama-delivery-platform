import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  Ajv2020,
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import * as formatsNamespace from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";

const addFormats = ("default" in formatsNamespace
  ? formatsNamespace.default
  : formatsNamespace) as unknown as FormatsPlugin;

const schemaFiles = {
  "bootstrap-input": "bootstrap-input.schema.json",
  "bootstrap-result": "bootstrap-result.schema.json",
  "canary-input": "canary-input.schema.json",
  "canary-result": "canary-result.schema.json",
  "delivery-contract": "delivery-contract.schema.json",
  "deployment-manifest": "deployment-manifest.schema.json",
  "deployment-pr-input": "deployment-pr-input.schema.json",
  "deployment-result": "deployment-result.schema.json",
  "inventory-audit-result": "inventory-audit-result.schema.json",
  "governance-input": "governance-input.schema.json",
  "governance-result": "governance-result.schema.json",
  "github-policy-audit-input": "github-policy-audit-input.schema.json",
  "github-policy-audit-result": "github-policy-audit-result.schema.json",
  "preflight-evidence": "preflight-evidence.schema.json",
  "preflight-run-input": "preflight-run-input.schema.json",
  "preflight-run-result": "preflight-run-result.schema.json",
  "publish-check-input": "publish-check-input.schema.json",
  "publish-check-result": "publish-check-result.schema.json",
  "promotion-input": "promotion-input.schema.json",
  "promotion-result": "promotion-result.schema.json",
  "release-evidence-input": "release-evidence-input.schema.json",
  "release-evidence-result": "release-evidence-result.schema.json",
  "reconciliation-evidence": "reconciliation-evidence.schema.json",
  "reconciliation-input": "reconciliation-input.schema.json",
  "reconciliation-result": "reconciliation-result.schema.json",
  "platform-release-manifest": "platform-release-manifest.schema.json",
  "paperclip-controller": "paperclip-controller.schema.json",
  "paperclip-binding-input": "paperclip-binding-input.schema.json",
  "paperclip-binding-result": "paperclip-binding-result.schema.json",
  "paperclip-controllers-input": "paperclip-controllers-input.schema.json",
  "paperclip-controllers-result": "paperclip-controllers-result.schema.json",
  "paperclip-foundation-input": "paperclip-foundation-input.schema.json",
  "paperclip-foundation-result": "paperclip-foundation-result.schema.json",
  "paperclip-github-transition-routine": "paperclip-github-transition-routine.schema.json",
  "paperclip-github-transition-routine-input": "paperclip-github-transition-routine-input.schema.json",
  "paperclip-github-transition-routine-result": "paperclip-github-transition-routine-result.schema.json",
  "paperclip-transition-authorization-input": "paperclip-transition-authorization-input.schema.json",
  "paperclip-transition-authorization-result": "paperclip-transition-authorization-result.schema.json",
  "paperclip-lifecycle": "paperclip-lifecycle.schema.json",
  "paperclip-routine": "paperclip-routine.schema.json",
  "paperclip-routines-input": "paperclip-routines-input.schema.json",
  "paperclip-routines-result": "paperclip-routines-result.schema.json",
  "paperclip-topology": "paperclip-topology.schema.json",
  "repository-inventory": "repository-inventory.schema.json",
  "repository-scope-policy": "repository-scope-policy.schema.json",
  "render-input": "render-input.schema.json",
  "secret-exceptions": "secret-exceptions.schema.json",
  "secrets-audit-input": "secrets-audit-input.schema.json",
} as const;

export type SchemaName = keyof typeof schemaFiles;

export interface SafeValidationError {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export type ValidationResult =
  | { readonly ok: true; readonly schema: SchemaName }
  | { readonly ok: false; readonly schema: SchemaName; readonly errors: readonly SafeValidationError[] };

function sanitizeError(error: ErrorObject): SafeValidationError {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  };
}

export interface SchemaValidator {
  validate(schema: SchemaName, input: unknown): ValidationResult;
}

export async function createSchemaValidator(repositoryRoot: string): Promise<SchemaValidator> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = new Map<SchemaName, ValidateFunction>();

  await Promise.all(
    (Object.entries(schemaFiles) as Array<[SchemaName, string]>).map(async ([name, filename]) => {
      const source: unknown = JSON.parse(await readFile(join(repositoryRoot, "schemas", filename), "utf8"));
      if (typeof source !== "object" || source === null || Array.isArray(source)) {
        throw new Error(`schema is not a JSON object: ${filename}`);
      }
      validators.set(name, ajv.compile(source as AnySchemaObject));
    }),
  );

  return {
    validate(schema, input) {
      const validator = validators.get(schema);
      if (validator === undefined) {
        throw new Error(`schema validator was not initialized: ${schema}`);
      }
      if (validator(input)) {
        return { ok: true, schema };
      }
      return {
        ok: false,
        schema,
        errors: (validator.errors ?? []).map(sanitizeError),
      };
    },
  };
}
