// review_code 子 agent 的能力：review_code（审查文件）
import OpenAI from 'openai';
import fs from 'node:fs';

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'review_code',
            description: '审查指定文件，返回"✅ Review 通过"或"❌ Review 不通过 + 具体原因"。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '要审查的文件路径' },
                },
                required: ['path'],
            },
        },
    },
];

export function executeTool(name: string, args: Record<string, unknown>): string {
    if (name === 'review_code') {
        const filePath = String(args.path ?? '').trim();
        if (!filePath) return '❌ Review 不通过: 缺少 path 参数';
        if (!fs.existsSync(filePath)) return `❌ Review 不通过: 文件不存在: ${filePath}`;
        if (!fs.statSync(filePath).isFile()) return `❌ Review 不通过: 不是文件: ${filePath}`;
        const code = fs.readFileSync(filePath, 'utf8');
        if (!code.trim()) return `❌ Review 不通过: 文件内容为空: ${filePath}`;

        // 简单的括号配平检查（只做粗筛，不涉及语法解析）
        const problems: string[] = [];
        for (const [open, close] of [['{', '}'], ['(', ')'], ['[', ']']] as const) {
            const diff = code.split(open).length - code.split(close).length;
            if (diff !== 0) problems.push(`${open}${close} 数量不匹配（相差 ${Math.abs(diff)}）`);
        }
        if (problems.length > 0) return `❌ Review 不通过: ${problems.join('；')}（${filePath}）`;
        return `✅ Review 通过: ${filePath}`;
    }
    return `失败: 未知工具 ${name}`;
}
