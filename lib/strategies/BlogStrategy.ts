export interface BlogStrategy {
    generate(content: string): Promise<{ content: string; demo?: string }>;
}
