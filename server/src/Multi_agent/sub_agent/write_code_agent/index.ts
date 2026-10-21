// write_code 子 agent 入口：主 agent 通过 spawn 以独立进程启动本文件
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'node:path';
import { ChatMessage } from '../../openai_base.js';
import { tools, executeTool } from './tools.js';
import { buildPrompt } from './prompt.js';

// 本文件在 src/Multi_agent/sub_agent/write_code_agent/，往上四层才是 server/
dotenv.config({ path: path.resolve(import.meta.dirname, '../../../..', '.env') });

const MODEL = process.env.OPENAI_MODEL ?? 'deepseek-flash';
const BASE_URL = process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.cn/v1';

/** 主 agent 通过 spawn 的环境变量传进来的信息 */
const NAME = process.env.SUBAGENT_NAME ?? 'write_code';
const TASK = process.env.SUBAGENT_TASK ?? '';

/** 与主 agent 约定的 finish 消息前缀 */
const FINISH_MARK = '@@FINISH@@';
const MAX_ROUNDS = 10;

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: BASE_URL,
});

/** 把 finish 消息通过 stdout 交给主 agent */
function finish(ok: boolean, result: string) {
    process.stdout.write(`${FINISH_MARK}${JSON.stringify({ name: NAME, ok, result })}\n`);
}

async function main() {
    const messages: ChatMessage[] = [
        { role: 'system', content: buildPrompt(NAME, TASK) },
        { role: 'user', content: TASK || '（主 agent 未提供任务）' },
    ];

    let wrote = false;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const stream = await openai.chat.completions.create({
            model: MODEL,
            messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            tools,
            tool_choice: 'auto',
            stream: true,
        });

        let content = '';
        const pending = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) content += delta.content;
            // 工具调用碎片：按 index 累积，等流结束再解析
            for (const tc of delta?.tool_calls ?? []) {
                const cur = pending.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                pending.set(tc.index, cur);
            }
        }

        // 没有工具调用 → 子任务结束
        if (pending.size === 0) {
            const summary = content.trim() || '任务已完成';
            if (!wrote) {
                finish(false, `未调用 write_code，任务未完成: ${summary}`);
            } else {
                finish(true, summary);
            }
            return;
        }

        const toolCalls = [...pending.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, c]) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.args },
            }));
        messages.push({ role: 'assistant', content, tool_calls: toolCalls });

        for (const call of toolCalls) {
            let args: Record<string, unknown>;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                args = {};
            }

            let result: string;
            try {
                result = executeTool(call.function.name, args);
            } catch (error) {
                result = `失败: 工具 ${call.function.name} 执行异常 —— ${error instanceof Error ? error.message : String(error)}`;
            }
            if (call.function.name === 'write_code' && !result.startsWith('失败')) wrote = true;

            // 只打印工具名和目标路径，避免把整段代码刷到主 agent 终端
            const target = typeof args.path === 'string' ? ` ${args.path}` : '';
            console.log(`  🔧 ${call.function.name}${target} → ${result.split('\n')[0]}`);

            messages.push({ role: 'tool', content: result, tool_call_id: call.id });
        }
    }

    finish(false, `达到最大工具调用轮次 ${MAX_ROUNDS}，任务可能尚未完成`);
}

main().catch((error) => {
    finish(false, `子 agent 执行异常: ${error instanceof Error ? error.message : String(error)}`);
});
