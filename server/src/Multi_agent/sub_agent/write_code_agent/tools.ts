// write_code 子 agent 的能力：write_code（写文件）
import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';

export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'write_code',
            description: '把代码写入指定文件（目录不存在会自动创建，文件已存在会覆盖）。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '目标文件路径' },
                    content: { type: 'string', description: '写入文件的完整代码内容' },
                },
                required: ['path', 'content'],
            },
        },
    },
];

export function executeTool(name: string, args: Record<string, unknown>): string {
    if (name === 'write_code') {
        const filePath = String(args.path ?? '').trim();
        if (!filePath) return '失败: 缺少 path 参数';
        fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
        fs.writeFileSync(filePath, String(args.content ?? ''), 'utf8');
        return `已写入文件: ${filePath}`;
    }
    return `失败: 未知工具 ${name}`;
}
