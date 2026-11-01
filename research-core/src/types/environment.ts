/** What a Experiment branch declares so the Host can build its CI environment. */
import type { BranchName, CommitSha } from './ids.js'

/**
 * Every Experiment gets its own environment built with uv. There is no shared
 * Program runtime fallback (review decision): a Experiment without a declaration is
 * invalid, not silently accepted.
 */
export type EnvironmentDeclaration =
  | {
      readonly kind: 'uv-lock'
      /** Repository-relative path of the lock file the Host installs with uv. */
      readonly lockFile: string
      readonly pythonVersion: string
    }
  | {
      readonly kind: 'requirements'
      readonly requirementsFile: string
      readonly pythonVersion: string
    }

/** The built environment handed to the CI entry. */
export interface BuiltEnvironment {
  readonly declaration: EnvironmentDeclaration
  /** Absolute interpreter path; exported as ALEPH_SUBMISSION_PYTHON. */
  readonly python: string
  readonly digest: string
  readonly root: string
}

export interface RepositorySnapshot {
  readonly branch: BranchName
  readonly commit: CommitSha
  /** Absolute path of the copied branch tree. */
  readonly root: string
}
