/** Every Experiment builds its own uv environment; no shared runtime fallback. */
import type { BranchName, CommitSha } from './ids.js'

export type EnvironmentDeclaration =
  | { readonly kind: 'uv-lock'; readonly lockFile: string; readonly pythonVersion: string }
  | { readonly kind: 'requirements'; readonly requirementsFile: string; readonly pythonVersion: string }

export interface RepositorySnapshot {
  readonly branch: BranchName
  readonly commit: CommitSha
  /** Absolute path of the copied Experiment tree. */
  readonly root: string
  /** Absolute path of the declaration file inside the snapshot. */
  readonly declarationPath: string
}

export interface BuiltEnvironment {
  readonly declaration: EnvironmentDeclaration
  readonly snapshot: RepositorySnapshot
  readonly python: string
  readonly digest: string
  readonly root: string
}
