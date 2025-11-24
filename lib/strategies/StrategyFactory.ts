import OpenAI from 'openai';
import { BlogStrategy } from './BlogStrategy';
import { RednoteStrategy } from './RednoteStrategy';
import { MediumStrategy } from './MediumStrategy';

export class StrategyFactory {
    static create(type: string, openai: OpenAI): BlogStrategy {
        switch (type) {
            case 'rednote':
                return new RednoteStrategy(openai);
            case 'medium':
                return new MediumStrategy(openai);
            default:
                throw new Error('Invalid strategy type');
        }
    }
}
