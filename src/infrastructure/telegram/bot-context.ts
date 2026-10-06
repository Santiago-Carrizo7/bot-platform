import type { Context } from 'grammy';
import type { ResolutionInfo } from '../../core/messaging/flow.js';

export interface BotContext extends Context {
  resolution?: ResolutionInfo;
}
