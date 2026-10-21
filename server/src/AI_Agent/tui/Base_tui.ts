// 基础的tui
import * as readline from 'node:readline';
import process from 'node:process';
import { ChatMessage } from './openai_base.js';
import { MODEL, BASE_URL, ask, executeTool } from '../tools/tools.js';
import { prompt } from '../Prompt/prompt.js';

/** 一轮提问内最多允许的"模型请求工具 → 本地执行 → 再问"轮次 */
const MAX_ROUNDS = 10;

// 读取用户输入
async function* readLines(iface: readline.Interface): AsyncGenerator<string> {
    const buffer: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;

    iface.on('line', (line) => {
        buffer.push(line);
        wake?.();
    });
    iface.on('close', () => {
        closed = true;
        wake?.();
    });

    // 有就取，没有就等；stdin 关了且取完了才结束 —— 这样 Ctrl+D 也能正常退出
    while (!closed || buffer.length > 0) {
        if (buffer.length === 0) {
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
            wake = null;
            continue;
        }
        yield buffer.shift() as string;
    }
}

/** 处理一轮提问：模型请求工具 → 本地执行 → 把结果（含失败）回给模型 → 再问，直到模型不再调用工具 */
async function handleTurn(messages: ChatMessage[]) {
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const stream = await ask(messages);

        let content = '';
        // 流式下工具调用是"碎片"，按 index 累积
        const pending = new Map<number, { id: string; name: string; args: string }>();

        process.stdout.write('LLM: ');
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;

            // 普通文字：边收边吐（打字机）
            if (delta?.content) {
                process.stdout.write(delta.content);
                content += delta.content;
            }

            // 工具调用碎片：先累积，别急着解析（此刻还不是合法 JSON）
            for (const tc of delta?.tool_calls ?? []) {
                const cur = pending.get(tc.index) ?? { id: '', name: '', args: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name = tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                pending.set(tc.index, cur);
            }

        }
        process.stdout.write('\n\n');
        // 没有工具调用 → 流程走完，记下回答，这一轮结束
        if (pending.size === 0) {
            messages.push({ role: 'assistant', content });
            return;
        }

        // 有工具调用 → 把"模型请求了什么"原样记进历史（id 和拼好的 arguments 都要）
        const toolCalls = [...pending.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, c]) => ({
                id: c.id,
                type: 'function' as const,
                function: { name: c.name, arguments: c.args },
            }));
        messages.push({
            role: 'assistant',
            content,
            tool_calls: toolCalls
        });
        // 逐个执行（支持一次多个调用），结果无论成功还是失败都以 tool 消息回给模型，
        // 这样模型才知道当前走到哪一步、下一步该做什么
        for (const call of toolCalls) {
            console.log(`  🔧 调用工具: ${call.function.name}(${call.function.arguments})`);
            let args: Record<string, unknown>;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch {
                args = {};
            }

            let result: string;
            try {
                result = await executeTool(call.function.name, args);
                console.log(`  ✅ 工具 ${call.function.name} 执行成功: ${result}`);
            } catch (error) {
                // 工具执行抛异常时也要回给模型，而不是让整个 TUI 崩掉
                result = `失败: 工具 ${call.function.name} 执行异常 —— ${error instanceof Error ? error.message : String(error)}`;
            }
            messages.push({ role: 'tool', content: result, tool_call_id: call.id });
        }
    }

    console.log(`（已达到最大工具调用轮次 ${MAX_ROUNDS}，任务可能尚未完成）`);
}
function print() {
    console.log('=========================================');
    console.log('  LLM 流式对话 TUI');
    console.log(`  model : ${MODEL}`);
    console.log(`  base  : ${BASE_URL}`);
    console.log('=========================================');
    console.log('');
}
async function main() {
    print();
    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: prompt,
        },
    ];
    // 读取用户输入
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for await (const line of readLines(rl)) {
        const input = line.trim();
        if (!input) continue;
        //把用户消息存进去，然后交给 handleTurn（内部可能来回多轮工具调用）
        messages.push({ role: 'user', content: input });
        await handleTurn(messages);

    }
    rl.close();

}
main().catch((error) => {
    console.error('出错:', error instanceof Error ? error.message : error);
    process.exit(1);
});



