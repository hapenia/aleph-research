/**
 * The one write path, as one method per command literal. A widened `UserCommand` or a
 * generic `CommandType` cannot be passed to a specific method, so the actor, payload and
 * result cannot be decoupled.
 */
import type { CommandOf, CommandContext, CommandOutcome, CommandType } from './commands.js'

export type CommandHandlers = {
  readonly [K in CommandType]: (
    command: CommandOf<K>,
    context: CommandContext<K>,
  ) => Promise<CommandOutcome<K>>
}

export type CommandExecutor = CommandHandlers
