import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import fs from 'node:fs';
import path from 'node:path';

const Tools: any = [
    {
        name: 'generate_mock',
        description: '根据 ApiUrl（如 /order/api）读取对应的 IDL 文件，把 IDL 的完整内容原样返回给调用方，由调用方的 AI 据此生成 mock 数据',
        inputSchema: {
            type: 'object',
            properties: {
                ApiUrl: {
                    type: 'string',
                    description: '接口的url地址，例如 /order/api 或 /product/api',
                },
            },
            required: ['ApiUrl'],
        },
    }
];

// IDL 目录：与本文件同级的 idl/
const IDL_DIR = path.resolve(import.meta.dirname, 'idl');

// /order/api → order-api.json
function toIdlFileName(apiUrl: string): string {
    const name = apiUrl.split('/').filter(Boolean)[0] ?? '';
    return `${name}-api.json`;
}

export const createServer = () => {
    const server = new Server(
        {
            name: 'mcp-genernationServer',
            version: '1.0.0',
        },
        {
            capabilities: {
                tools: {},
            }
        },
    );
    //这个是获取工具列表的处理函数
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Tools,
    }))
    //这个是调用工具的处理函数
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name === 'generate_mock') {
            const apiUrl = String((args as any)?.ApiUrl ?? '').trim();
            if (!apiUrl) {
                return { content: [{ type: 'text', text: '错误: 缺少参数 ApiUrl' }], isError: true };
            }

            const fileName = toIdlFileName(apiUrl);
            const filePath = path.join(IDL_DIR, fileName);
            if (!fs.existsSync(filePath)) {
                return {
                    content: [{ type: 'text', text: `找不到对应的 IDL 文件: idl/${fileName}（ApiUrl: ${apiUrl}）` }],
                    isError: true,
                };
            }

            // 把 IDL 的完整内容原样交给调用方，服务端不做任何解析或生成
            const idl = fs.readFileSync(filePath, 'utf8');
            const useContent = `
            请根据以下 IDL 文件内容，生成 mock 数据：
            ${idl}
            请根据 IDL 文件内容，生成 mock 数据，数据格式为 JSON 字符串，包含所有可能的字段和值。
            `
            return {
                content: [{ type: 'text', text: useContent }],
            };
        }
        return {
            content: [{ type: 'text', text: `未知工具: ${name}` }],
            isError: true,
        };
    })
    // 这里是启动服务器
    const transport = new StdioServerTransport();
    server.connect(transport);

    return server;
}
