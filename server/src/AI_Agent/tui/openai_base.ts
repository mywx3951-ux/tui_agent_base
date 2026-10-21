
export type ChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    /** 助手"请求调用工具"时携带（只出现在 assistant 消息上） */
    tool_calls?: ToolCall[];
    /** 工具结果对应哪次请求（只出现在 tool 消息上） */
    tool_call_id?: string;
};

/** 模型请求的一次工具调用 */
export type ToolCall = {
    id: string;
    type: 'function';
    function: {
        name: string;
        /** 注意：这里是 JSON 字符串，不是对象，必须 JSON.parse */
        arguments: string;
    };
};