/**
 * The one write path. The generic is constrained by the command literal, so the result
 * type cannot be chosen by the caller and unknown commands do not exist.
 */
import type { CommandOf, CommandContext, CommandResult, CommandType, Decision } from './commands.js'
import type { DomainError, Result } from './errors.js'

export type CommandHandlers = {
  readonly [K in CommandType]: (
    command: CommandOf<K>,
    context: CommandContext<K>,
  ) => Promise<Result<Decision<CommandResult<K>>, DomainError>>
}

export interface CommandExecutor {
  execute<K extends CommandType>(
    command: CommandOf<K>,
    context: CommandContext<K>,
  ): Promise<Result<Decision<CommandResult<K>>, DomainError>>
}
