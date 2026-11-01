/** What a Pull request branch declares so the Host can build its CI environment. */
import type { BranchName, CommitSha } from './ids.js'

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
  | { readonly kind: 'program-runtime' }

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
