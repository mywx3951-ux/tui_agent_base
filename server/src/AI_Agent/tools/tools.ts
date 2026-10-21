import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { ChatMessage } from '../tui/openai_base.js';

// 本文件在 src/AI_Agent/tools/，往上三层才是 server/，.env 在 server/ 下
dotenv.config({ path: path.resolve(import.meta.dirname, '../../..', '.env') });

export const MODEL = process.env.OPENAI_MODEL ?? 'deepseek-flash';
export const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.cn/v1';

// LLM 客户端（只给本文件的 ask 用，不对外暴露）
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: BASE_URL,
});

// 工具定义：告诉模型"你能调用哪些工具"（模型只负责请求，真正干活的是下面 executeTool）
export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'create_directory',
            description: '创建一个文件夹，可创建多层目录，如 a/b/c。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '要创建的文件夹路径' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: '读取指定文件的文本内容。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '要读取的文件路径' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'create_file',
            description: '创建新文件并写入内容（文件已存在时会失败）。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '要创建的文件路径' },
                    content: { type: 'string', description: '写入文件的文本内容' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'edit_file',
            description: '修改已有文件的内容（用新内容覆盖，文件必须已存在）。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '要修改的文件路径' },
                    content: { type: 'string', description: '覆盖写入的新内容' },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'review_code',
            description: '对指定文件里的代码做一次简单审查，返回"通过"或"不通过 + 具体原因"。',
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

// 本地真正执行工具：模型只会"请求"，到底做不做由这里的代码决定
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'create_directory') {
        const dir = String(args.path ?? '').trim();
        if (!dir) return '失败: 缺少 path 参数';
        fs.mkdirSync(dir, { recursive: true });
        return `已创建目录: ${dir}`;
    }
    if (name === 'read_file') {
        const filePath = String(args.path ?? '').trim();
        if (!filePath) return '失败: 缺少 path 参数';
        if (!fs.existsSync(filePath)) return `失败: 文件不存在: ${filePath}`;
        if (!fs.statSync(filePath).isFile()) return `失败: 不是文件: ${filePath}`;
        return fs.readFileSync(filePath, 'utf8');
    }
    if (name === 'create_file') {
        const filePath = String(args.path ?? '').trim();
        if (!filePath) return '失败: 缺少 path 参数';
        if (fs.existsSync(filePath)) return `失败: 文件已存在，请用 edit_file 修改: ${filePath}`;
        fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
        fs.writeFileSync(filePath, String(args.content ?? ''), 'utf8');
        return `已创建文件: ${filePath}`;
    }
    if (name === 'edit_file') {
        const filePath = String(args.path ?? '').trim();
        if (!filePath) return '失败: 缺少 path 参数';
        if (!fs.existsSync(filePath)) return `失败: 文件不存在，请用 create_file 创建: ${filePath}`;
        fs.writeFileSync(filePath, String(args.content ?? ''), 'utf8');
        return `已修改文件: ${filePath}`;
    }
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

// 带上工具定义去问模型，返回流
export async function ask(messages: ChatMessage[]) {
    return openai.chat.completions.create({
        model: MODEL,
        messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools,
        tool_choice: 'auto',
        stream: true,
    });
}
