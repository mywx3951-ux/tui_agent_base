import OpenAI from 'openai';
import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ChatMessage } from './openai_base.js';

// 本文件在 src/Multi_agent/，往上两层才是 server/，.env 在 server/ 下
dotenv.config({ path: path.resolve(import.meta.dirname, '../..', '.env') });

export const MODEL = process.env.OPENAI_MODEL ?? 'deepseek-flash';
export const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.cn/v1';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: BASE_URL,
});

const SERVER_ROOT = path.resolve(import.meta.dirname, '../..');
// 子应用入口目录：每个子应用对应这里的一个入口文件
const SUB_AGENT_DIR = path.resolve(import.meta.dirname, 'sub_agent');

/** 子应用名称 → 入口文件（每个 agent 一个独立文件夹）；call_subagent 时按名称找到入口，单独起一个进程 */
const AGENT_ENTRIES: Record<string, string> = {
    write_code: 'write_code_agent/index.ts',
    review_code: 'review_code_agent/index.ts',
};

/** 子应用用这一行前缀把 finish 消息写进 stdout，主 agent 据此判断任务结果 */
const FINISH_MARK = '@@FINISH@@';
const SUB_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export type TodoStatus = 'pending' | 'running' | 'done' | 'failed';

export type Todo = {
    /** 任务唯一 id，由主 agent 在 create_todo_list 里指定 */
    id: string;
    title: string;
    /** 负责执行的子应用名称，如 write_code */
    agent: string;
    /** 计划交给子应用的任务描述 */
    description: string;
    status: TodoStatus;
    /** 子应用返回的 finish 消息内容 */
    result?: string;
};

/** 主 agent 维护的 todoList */
export const todos: Todo[] = [];

// 工具定义：主 agent 只负责建清单和调用子 agent
export const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: 'function',
        function: {
            name: 'create_todo_list',
            description: '创建（或覆盖）本次需求的待办清单。每项任务最终会通过 call_subagent 交给对应子应用执行。',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: '按执行顺序排列的任务列表',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: '任务唯一 id，如 t1、t2' },
                                title: { type: 'string', description: '任务标题' },
                                agent: {
                                    type: 'string',
                                    enum: Object.keys(AGENT_ENTRIES),
                                    description: '负责执行的子应用名称',
                                },
                                description: { type: 'string', description: '计划交给子应用的任务描述' },
                            },
                            required: ['id', 'title', 'agent', 'description'],
                        },
                    },
                },
                required: ['todos'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'call_subagent',
            description:
                '调用一个子 agent：为它启动独立进程执行任务，阻塞等待并返回 finish 消息。name 为子应用名称，task 为希望这个 agent 去执行什么任务。',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        enum: Object.keys(AGENT_ENTRIES),
                        description: '子应用名称',
                    },
                    task: { type: 'string', description: '主任务希望这个 agent 去执行什么任务' },
                },
                required: ['name', 'task'],
            },
        },
    },
];

/** 子 agent 返回给主 agent 的 finish 消息 */
type SubAgentFinish = {
    name: string;
    ok: boolean;
    result: string;
};

function formatTodos(): string {
    if (todos.length === 0) return '（空）';
    return todos
        .map((t) => {
            const mark =
                t.status === 'done' ? 'x' : t.status === 'failed' ? '!' : t.status === 'running' ? '~' : ' ';
            return `- [${mark}] ${t.id} (${t.agent}) ${t.title}${t.result ? ` → ${t.result}` : ''}`;
        })
        .join('\n');
}

function parseFinish(raw: string): SubAgentFinish | null {
    try {
        const data = JSON.parse(raw);
        return {
            name: String(data.name ?? ''),
            ok: Boolean(data.ok),
            result: String(data.result ?? ''),
        };
    } catch {
        return null;
    }
}

/**
 * 为子应用启动独立进程执行任务。
 * 任务内容通过环境变量传给子进程（SUBAGENT_NAME / SUBAGENT_TASK），
 * 子进程在 stdout 打印一行 `@@FINISH@@{...}` 表示结束，普通日志按行透传给用户查看。
 */
function runSubAgent(agentName: string, task: string): Promise<SubAgentFinish> {
    const entryFile = path.join(SUB_AGENT_DIR, AGENT_ENTRIES[agentName] as string);

    const child = spawn(process.execPath, ['--import', 'tsx', entryFile], {
        cwd: SERVER_ROOT,
        // 主子通信：任务信息走环境变量，子进程拿到的是自己的一份 env
        env: {
            ...process.env,
            SUBAGENT_NAME: agentName,
            SUBAGENT_TASK: task,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve) => {
        let buffer = '';
        let finished = false;
        let timer: NodeJS.Timeout | undefined;

        const settle = (finish: SubAgentFinish) => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            resolve(finish);
        };

        const handleLine = (line: string) => {
            if (line.startsWith(FINISH_MARK)) {
                const finish = parseFinish(line.slice(FINISH_MARK.length));
                if (finish) settle({ ...finish, name: finish.name || agentName });
                return;
            }
            // 子进程的普通日志原样透传
            if (line) process.stdout.write(`  [子agent ${agentName}] ${line}\n`);
        };

        timer = setTimeout(() => {
            child.kill();
            settle({ name: agentName, ok: false, result: `子 agent 执行超时（${SUB_AGENT_TIMEOUT_MS / 1000}s）` });
        }, SUB_AGENT_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            let end: number;
            while ((end = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, end).trim();
                buffer = buffer.slice(end + 1);
                handleLine(line);
            }
        });

        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            process.stderr.write(`  [子agent ${agentName}] ${text}`);
        });

        child.on('error', (error) => {
            settle({ name: agentName, ok: false, result: `子 agent 启动失败: ${error.message}` });
        });

        child.on('close', (code) => {
            // finish 行可能没有以换行符结尾，收尾时再解析一次
            handleLine(buffer.trim());
            buffer = '';
            settle({
                name: agentName,
                ok: false,
                result: `子 agent 退出（code=${code}）但未返回 finish 消息`,
            });
        });
    });
}

// 本地执行主 agent 的工具
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'create_todo_list') {
        const raw = args.todos;
        if (!Array.isArray(raw) || raw.length === 0) return '失败: todos 必须是非空数组';

        const next: Todo[] = [];

        for (const item of raw as Record<string, unknown>[]) {
            const id = String(item?.id ?? '').trim();
            const title = String(item?.title ?? '').trim();
            const agent = String(item?.agent ?? '').trim();
            const description = String(item?.description ?? '').trim();
            if (!id || !title || !description) return `失败: 任务字段不完整: ${JSON.stringify(item)}`;
            if (!AGENT_ENTRIES[agent]) {
                return `失败: 未知的子应用 ${agent}，当前可用: ${Object.keys(AGENT_ENTRIES).join(', ')}`;
            }
            if (next.some((t) => t.id === id)) return `失败: 任务 id 重复: ${id}`;
            next.push({ id, title, agent, description, status: 'pending' });
        }

        todos.splice(0, todos.length, ...next);
        return `已创建 todoList（${todos.length} 项）:\n${formatTodos()}\n请按顺序调用 call_subagent 逐个执行。`;
    }

    if (name === 'call_subagent') {
        const agentName = String(args.name ?? '').trim();
        const task = String(args.task ?? '').trim();
        if (!AGENT_ENTRIES[agentName]) {
            return `失败: 未知的子应用 ${agentName}，当前可用: ${Object.keys(AGENT_ENTRIES).join(', ')}`;
        }
        if (!task) return '失败: 缺少 task 参数';

        // 同一子应用按派发顺序对应 todoList 里的 pending 任务，便于跟踪进度
        const todo = todos.find((t) => t.agent === agentName && t.status === 'pending');
        if (todo) todo.status = 'running';

        console.log(`  🚀 启动子应用 ${agentName}（独立进程）...`);
        const finish = await runSubAgent(agentName, task);

        if (todo) {
            todo.status = finish.ok ? 'done' : 'failed';
            todo.result = finish.result;
        }

        const allDone = todos.length > 0 && todos.every((t) => t.status === 'done');
        return [
            `finish 消息: name=${finish.name}, ok=${finish.ok}, result=${finish.result}`,
            '',
            '当前 todoList:',
            formatTodos(),
            '',
            allDone ? '所有任务已完成，请向用户汇总结果。' : '还有未完成任务，请判断是否继续调用 call_subagent。',
        ].join('\n');
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
