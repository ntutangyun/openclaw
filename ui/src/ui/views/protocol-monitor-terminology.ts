import { html, nothing, type TemplateResult } from "lit";

type TerminologyGroup = {
  title: string;
  intro?: string;
  terms: Array<{ term: string; definition: TemplateResult }>;
};

const TERMINOLOGY_GROUPS: TerminologyGroup[] = [
  {
    title: "Usage Overview 指标",
    intro: "下列术语用于 Protocol & Network 页面顶部 Usage Overview 指标的计算。",
    terms: [
      {
        term: "Transcript",
        definition: html`一次 agent run 中累积下来的完整 message 序列 —— 包含 user prompt、
          assistant 回复、tool call 以及 tool result。每一轮,整个 transcript(或其压缩后的
          形式)都会作为 input 重新发给 model,这也是为什么 input token 数会在一个 session
          的过程中持续增长。
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 1</div>
            <div>
              一个 session 里进行了 3 轮对话(user 1 → assistant 1 → user 2 → assistant 2 → user 3 →
              assistant 3)。到第 3 轮发给 model 的 input 是:system prompt + 前 4 条 message(user
              1、assistant 1、user 2、assistant 2)+ user 3 这条新 message。
            </div>
          </div>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 2</div>
            <div>
              假设 system prompt 是 500 tokens,每轮 user 平均 50 tokens,assistant 平均 200
              tokens。那么 input token 的大致增长是:第 1 轮 ≈ 550、第 2 轮 ≈ 800、第 3 轮 ≈ 1050 ——
              在 Avg Tokens 这个指标里就体现为逐轮上升。
            </div>
          </div>`,
      },
      {
        term: "Session",
        definition: html`一次在逻辑上完整的对话或 agent run,拥有持久化的状态(transcript、 tool
          状态、model 上下文)。usage 指标会对选定范围内的所有 session 做聚合;按 model
          过滤时,会把聚合范围收窄到这些 session 中的某一个 model。
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 1</div>
            <div>
              打开聊天窗口、来回对话、关闭 —— 算一个 session。再打开一个新的聊天窗口开始对话 ——
              另一个 session。Usage Overview 里的 Messages、Tool Calls、Total Tokens 都是跨 session
              累加的。
            </div>
          </div>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 2</div>
            <div>
              时间窗口内有 10 个 session,其中 6 个用了 gpt-5、4 个用了 claude-sonnet。把 model
              过滤器切到 gpt-5 之后,Usage Overview 里的数字会仅基于那 6 个 session 重新聚合。
            </div>
          </div>`,
      },
      {
        term: "Token",
        definition: html`model 读写的最小文本单元(大致相当于几个字符)。usage 会被拆成
          <em>input tokens</em>(发给 model 的 prompt + transcript)、<em>output tokens</em>
          (model 生成的内容),以及 cache tokens(见下文)。费用按 token 计,input、output、 cache
          read、cache create 各自有不同的单价。
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 1</div>
            <div>
              一句英文 "Hello, world!" 大概是 4 个 tokens;一段 500 字的 assistant 回复大概是 700
              tokens。中文通常一个字 ≈ 1&ndash;2 tokens,所以 "你好,世界!" 大约 5 个 tokens。
            </div>
          </div>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 2</div>
            <div>
              Total Tokens 里显示 <code>in 12K · out 3K</code>:意味着这段时间内发给 model 的 prompt
              累计 12,000 tokens,model 生成回来的内容累计 3,000 tokens。Avg Tokens 则是 (12K + 3K +
              cache) ÷ message 数。
            </div>
          </div>`,
      },
      {
        term: "Cache",
        definition: html`model provider 的 <em>prompt cache</em> —— 一段先前请求的、字节级
          完全相同的前缀会被 provider 保持在"热"状态,以便被便宜、快速地复用。
          <strong>cache create</strong> token 是写入一段新前缀时收费的部分(一般比 input 贵一些,例如
          Anthropic ~1.25×);<strong>cache read</strong> token 是复用已有前缀时
          按较低单价收费的部分(例如 Anthropic ~0.1× input)。 <strong>cache hit rate</strong> = cache
          reads ÷ (input + cache reads)。

          <div class="pm-term-subheading">谁决定 cache create vs cache read</div>
          <p class="pm-term-para">缓存机制分成三方职责:</p>
          <ul class="pm-term-list-inline">
            <li>
              <strong>Client(agent / OpenClaw)</strong>:决定在 prompt 的哪些位置"切一刀",
              把前缀标成可缓存。对 Anthropic 来说是在 message 上加
              <code>cache_control: { type: "ephemeral" }</code> 标记;OpenAI 的 prompt cache
              则完全自动,client 不需要标。
            </li>
            <li>
              <strong>Provider(Anthropic / OpenAI / …)</strong>:把当前请求的 prompt 前缀
              跟自己那边存着的"热"前缀逐字节对比,然后 <em>逐 token 判定</em>:命中 → 算作
              <code>cache_read</code>;未命中但在 client 的 cache 标记之前 → 算作
              <code>cache_write</code>(也叫 <code>cache_create</code>);cache 标记之后、 或完全没有
              cache 标记的部分 → 算作普通 <code>input</code>。
            </li>
            <li>
              <strong>OpenClaw</strong>:只是把 provider 在 <code>usage</code> 响应里告诉它的
              四个字段(input、cache_read、cache_write、output)原样记录下来。它既不决定哪些 token
              进缓存,也不参与比对。
            </li>
          </ul>

          <div class="pm-term-subheading">谁维护"热"状态</div>
          <p class="pm-term-para">
            缓存条目保存在 <strong>provider 自己的基础设施里</strong>,带有 TTL:
          </p>
          <ul class="pm-term-list-inline">
            <li>
              Anthropic 默认 ephemeral cache TTL ≈ 5 分钟;另有 1h 的 beta 选项可延长到 1 小时。
            </li>
            <li>OpenAI 的自动 prompt cache TTL 也很短(分钟级),没有延长选项。</li>
            <li>
              如果两次请求的间隔超过 TTL,下一次同样的前缀会 <em>重新</em>付 cache_write, 而不是
              cache_read。Client 这边没有任何"保活"的办法(除了频繁发请求)。
            </li>
          </ul>

          <div class="pm-term-subheading">Provider 如何在 usage 里汇报</div>
          <p class="pm-term-para">
            cache_read 和 cache_write 都是由 provider 在每次响应的 <code>usage</code> 字段里
            <em>直接告诉 client 的</em> —— OpenClaw 不参与推算,只是把数字原样记录。不同 provider
            汇报的方式略有差异:
          </p>
          <ul class="pm-term-list-inline">
            <li>
              <strong>Anthropic</strong>(Messages API):每次响应都会返回
              <code>input_tokens</code>、<code>cache_creation_input_tokens</code>(= cache_write)、
              <code>cache_read_input_tokens</code>、<code>output_tokens</code> 四个字段。不适用
              的字段会是 0,但都始终存在。
              <p class="pm-explainer-mini">
                "usage": {<br />
                &nbsp;&nbsp;"input_tokens": 123,<br />
                &nbsp;&nbsp;"cache_creation_input_tokens": 2000,<br />
                &nbsp;&nbsp;"cache_read_input_tokens": 0,<br />
                &nbsp;&nbsp;"output_tokens": 456<br />
                }
              </p>
            </li>
            <li>
              <strong>OpenAI</strong>(Chat Completions / Responses):只在
              <code>prompt_tokens_details.cached_tokens</code> 里报告 <em>读侧</em>(相当于
              cache_read)。因为 OpenAI 的 prompt cache 是全自动的,不对 client 单独计费"写
              缓存"这一步 —— 写入的成本已经折算进普通的 <code>prompt_tokens</code> 里。
              <p class="pm-explainer-mini">
                "usage": {<br />
                &nbsp;&nbsp;"prompt_tokens": 2123,<br />
                &nbsp;&nbsp;"completion_tokens": 456,<br />
                &nbsp;&nbsp;"prompt_tokens_details": { "cached_tokens": 2000 }<br />
                }
              </p>
            </li>
            <li>
              <strong>Google Gemini</strong>:情况跟 OpenAI 类似,只在
              <code>cachedContentTokenCount</code> 里报告命中缓存的 token 数。写缓存是走一个 独立的
              explicit cache API,按"存储时长"计费,<em>不</em> 出现在每次请求的 usage 字段里。
            </li>
          </ul>
          <p class="pm-term-para">
            所以在 OpenAI 和 Gemini 这类 provider 上,OpenClaw 这边的 <code>cache_write</code>
            基本会一直是 0(因为 provider 根本不汇报这个桶)。这不是 bug —— 只是这些 provider
            的计费模型里没有单独的"写入"步骤。Cache Hit 卡片的分母依然是
            <code>input + cache_read</code>,和 Anthropic 一致。
          </p>

          <div class="pm-term-subheading">
            为什么 total tokens = input + output + cache_read + cache_write
          </div>
          <p class="pm-term-para">
            因为 provider 把这四个字段设计成 <strong>互不相交的计费桶</strong> —— 每一个 token
            都恰好落进其中一桶,于是直接相加就是总数,不会重复计算。在 Anthropic 的
            <code>usage</code> 响应里这四个字段分别是:
          </p>
          <ul class="pm-term-list-inline">
            <li>
              <code>input_tokens</code>:这次请求里 <em>重新 tokenize</em> 的 prompt token ——
              <strong>不是</strong>从缓存读出的,也不是要写入缓存的。
            </li>
            <li>
              <code>cache_read_input_tokens</code>:命中了热前缀、从缓存 <em>读出</em> 的 prompt
              token(按折扣价计费)。
            </li>
            <li>
              <code>cache_creation_input_tokens</code>:这次请求里 <em>写入</em> 缓存以供未来 复用的
              prompt token(按溢价计费)。
            </li>
            <li><code>output_tokens</code>:model 这次 <em>生成</em> 出来的 token。</li>
          </ul>
          <p class="pm-term-para">所以一次请求的 prompt 侧可能横跨三个桶:</p>
          <p class="pm-explainer-mini">
            prompt tokens sent = input + cache_read + cache_write<br />
            total tokens = input + cache_read + cache_write + output
          </p>

          <div class="pm-term-subheading">为什么 cache_read 没算进 input</div>
          <p class="pm-term-para">
            两个原因。第一,它们是 <em>不同的计费桶</em> —— input 是全价,cache_read 通常只是 input 的
            10% 左右;把它俩合并会把不同价格的 token 搅成一团,无法准确统计成本。 第二,<strong
              >Cache Hit</strong
            >
            卡片的公式 <code>cacheRead / (input + cacheRead)</code> 正好依赖这两者互不相交 —— 如果把
            cache_read 合并进 input,分母已经包含了命中部分,命中率就永远是 0%。
          </p>

          <div class="pm-term-example">
            <div class="pm-term-example-label">例 1</div>
            <div>
              一个 2,000 tokens 的 system prompt 在 10 轮对话里反复出现。第 1 轮把它写入缓存 (2,000
              cache_write tokens),之后的 9 轮都能从缓存命中(9 × 2,000 = 18,000 cache_read
              tokens)。Cache Hit Rate ≈ 18,000 / (2,000 + 18,000) = 90%。注意第 1 轮的 2,000 tokens
              算的是 cache_write,<em>不是</em> input;它没进入命中率的分母。
            </div>
          </div>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 2</div>
            <div>
              如果每一轮都在 system prompt 中拼入当前时间戳,前缀就不再字节相同,缓存命中不了 —— Cache
              Hit Rate 会跌到接近 0%,而 Total Cost 会明显上升。这也是排查缓存失效时
              最常见的原因之一。
            </div>
          </div>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例 3</div>
            <div>
              即使前缀完全不变,如果两次请求间隔超过了 provider 的 TTL(Anthropic 默认 ~5 分钟),
              缓存条目会过期。下一次相同的 prefix 会再次计为 cache_write,相当于重新"预热"。
              长时间静置的 session 第一轮通常会看到 cache hit rate 偏低。
            </div>
          </div>`,
      },
    ],
  },
  {
    title: "Errors",
    intro:
      "Usage Overview 里的 Error Rate 卡片的口径。错误被拆成 assistant errors 和 tool errors 两类,卡片主数值是错误率,小字下方显示两类各自的计数。",
    terms: [
      {
        term: "Error Rate",
        definition: html`卡片上的主数值:<code>errorRate = errors / messages.total</code>,以百分比
          表示。分母只算 user + assistant 两类 message —— system prompt、tool / toolResult
          这类单独的 role 都不计入 <code>messages.total</code>。分子
          <code>errors = assistantErrors + toolErrors</code> 把 <em>所有</em> 错误信号加起来,
          因此一轮 turn 里如果既出现 stopReason=error、又出现多条 is_error 的 tool result,它们会
          <em>全部</em> 叠加进分子,所以 error rate 理论上可以超过 100%。
          <div class="pm-term-subheading">颜色阈值</div>
          <ul class="pm-term-list-inline">
            <li><strong>Good(绿):</strong> ≤ 1%。</li>
            <li><strong>Warn(黄):</strong> 1 – 5%。</li>
            <li><strong>Bad(红):</strong> 大于 5%。</li>
          </ul>`,
      },
      {
        term: "Assistant Errors",
        definition: html`卡片副标题"N assistant · M tool"里的前半部分,对应源码里的
          <code>messageCounts.assistantErrors</code>。只统计由
          <em>assistant 回合终止原因</em> 触发的错误:每次遇到
          <code>stopReason ∈ { "error", "aborted", "timeout" }</code> 的 assistant message 就
          +1。用来衡量 <strong>模型 / 运行时侧</strong>(而不是工具侧) 的失败。
          <div class="pm-term-subheading">典型 +1 场景</div>
          <ul class="pm-term-list-inline">
            <li>
              <strong>error</strong> —— provider 返回的 <code>finish_reason</code> 是
              <code>content_filter</code>、<code>network_error</code> 或其它未识别值;流/传输失败 经
              <code>buildStreamErrorAssistantMessage</code> 合成错误助手消息;"Unhandled stop reason"
              被 OpenClaw 事后改写为 <code>stopReason: "error"</code>。
            </li>
            <li>
              <strong>aborted</strong> —— 用户或系统主动中止,由 <code>sessions_yield</code> 合成
              aborted 响应,避免真实 provider 调用。
            </li>
            <li>
              <strong>timeout</strong> —— Gateway 的 chat run 维护循环发现 TTL 到期后调用
              <code>abortChatRunById</code>,把 stopReason 设为 <code>"timeout"</code>。
            </li>
          </ul>`,
      },
      {
        term: "Tool Errors",
        definition: html`卡片副标题里的后半部分,对应源码里的
          <code>messageCounts.toolErrors</code>。统计 <em>被标记为 error 的 tool result</em>: 每条
          <code>role: "toolResult"</code> 消息带 <code>isError === true</code> 或内联
          <code>tool_result</code> / <code>tool_result_error</code> 内容块带
          <code>is_error: true</code> 时 +1。用来衡量 <strong>工具执行层</strong>(agent
          runner、pi-embedded runner、MCP、ACP、transport 修复层等)侧的失败。
          <div class="pm-term-subheading">典型 +1 场景</div>
          <ul class="pm-term-list-inline">
            <li>
              Provider 直接透传带 <code>is_error: true</code> 的 tool result 块(Anthropic 风格 SDK
              常见)。
            </li>
            <li>
              OpenClaw 工具执行层主动返回 <code>isError: true</code>:agent runner 的 rate-limit /
              overloaded 提示、pi-embedded runner 的各种终端失败(context overflow、role
              ordering、image size、timeout、strict-agentic blocked、incomplete turn、retry-limit
              等)、MCP 插件 / 通道工具(未知工具、执行异常)、Gateway MCP HTTP handler 异常、 ACP 分发
              stale / 回合失败、<code>/btw</code> 命令失败。
            </li>
            <li>
              传输层 / 转录修复层的补位 —— 缺少配对 tool_result 的 tool_use 在
              <code>transport-message-transform</code> 被插入一条 "No result provided";历史会话
              里丢失的 tool_result 被 <code>session-transcript-repair</code> 标记为 "inserted
              synthetic error result"。
            </li>
          </ul>`,
      },
      {
        term: "错误信号映射表",
        definition: html`下表列出所有会被计入 Error Rate 的原始场景、OpenClaw 在转录里实际落地的
          信号形态,以及它属于哪一类。<code>stop</code> 表示会 +1 到 <em>assistant errors</em>;
          <code>tool</code> 表示会 +1 到 <em>tool errors</em>。
          <div class="pm-term-table-wrap">
            <table class="pm-term-table">
              <thead>
                <tr>
                  <th>原始错误</th>
                  <th>OpenClaw 信号</th>
                  <th>类别</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr class="pm-term-table-section">
                  <td colspan="4">A. 助手 stopReason 来源 — OpenClaw 运行时写入助手消息</td>
                </tr>
                <tr>
                  <td>OpenAI 兼容 provider 返回 <code>finish_reason: "content_filter"</code></td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>内容审核拦截;<code>openai-transport-stream.ts</code>。</td>
                </tr>
                <tr>
                  <td>OpenAI 兼容 provider 返回 <code>finish_reason: "network_error"</code></td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>provider 侧网络故障。</td>
                </tr>
                <tr>
                  <td>OpenAI 兼容 provider 返回未识别的 <code>finish_reason</code></td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>default 分支兜底;errorMessage 带原始 reason。</td>
                </tr>
                <tr>
                  <td>Ollama 流式调用底层异常</td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>扩展 <code>extensions/ollama/src/stream.ts</code> 合成错误助手消息。</td>
                </tr>
                <tr>
                  <td>pi-agent-core 抛出 "Unhandled stop reason: X"</td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>
                    <code>attempt.stop-reason-recovery.ts</code> 事后补丁;errorMessage 改写为
                    用户友好提示。
                  </td>
                </tr>
                <tr>
                  <td>通用传输 / 流式错误(连接断、解析失败、鉴权失败等)</td>
                  <td><code>stopReason: "error"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>
                    <code>buildStreamErrorAssistantMessage</code> 生成零 usage 的合成助手消息。
                  </td>
                </tr>
                <tr>
                  <td>用户 / 系统发起的中止(<code>sessions_yield</code> 等)</td>
                  <td><code>stopReason: "aborted"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>避免真实 provider 调用;零 usage 的合成响应。</td>
                </tr>
                <tr>
                  <td>Gateway chat run TTL 到期</td>
                  <td><code>stopReason: "timeout"</code></td>
                  <td><span class="pm-term-tag pm-term-tag--stop">stop</span></td>
                  <td>
                    <code>server-maintenance.ts</code> 维护循环调用 <code>abortChatRunById</code>。
                  </td>
                </tr>
                <tr class="pm-term-table-section">
                  <td colspan="4">
                    B. 工具结果 <code>isError: true</code> 来源 — OpenClaw 工具执行 / 修复层写入
                  </td>
                </tr>
                <tr>
                  <td>
                    Provider 回传的 <code>tool_result</code> / <code>tool_result_error</code> 块带
                    <code>is_error: true</code>
                  </td>
                  <td>内联 block is_error</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>Anthropic 风格 SDK 直接透传;<code>countToolResults</code> 统计内容块。</td>
                </tr>
                <tr>
                  <td>模型留下缺失配对的 tool_use(无对应 tool_result)</td>
                  <td>合成 toolResult, isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>
                    <code>transport-message-transform.ts</code> 补位,文本 "No result provided", 防止
                    provider 校验失败。
                  </td>
                </tr>
                <tr>
                  <td>历史会话里丢失的 tool_result</td>
                  <td>合成 toolResult, isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>
                    <code>session-transcript-repair.ts</code> 插入 "inserted synthetic error
                    result"。
                  </td>
                </tr>
                <tr>
                  <td>上下文超限 / 自动压缩失败</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>
                    error.kind = <code>context_overflow</code> / <code>compaction_failure</code>,
                    提示 /reset 或换更大上下文模型。
                  </td>
                </tr>
                <tr>
                  <td>角色顺序冲突(roles must alternate)</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>error.kind = <code>role_ordering</code>;提示 /new。</td>
                </tr>
                <tr>
                  <td>图片体积超出模型上限</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>解析 provider 错误后给出带 max MB 的用户友好提示。</td>
                </tr>
                <tr>
                  <td>请求超时 / LLM 空闲超时</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>
                    提示可调 <code>agents.defaults.timeoutSeconds</code> /
                    <code>llm.idleTimeoutSeconds</code>。
                  </td>
                </tr>
                <tr>
                  <td>Strict-Agentic 模式 planning-only 重试上限</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>严格 agentic 合同被拒,文本 <code>STRICT_AGENTIC_BLOCKED_TEXT</code>。</td>
                </tr>
                <tr>
                  <td>助手回合不完整(incomplete turn)</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>触发 auth 档位冷却并回抛错误。</td>
                </tr>
                <tr>
                  <td>内部重试达到上限</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>error.kind = <code>retry_limit</code>。</td>
                </tr>
                <tr>
                  <td>provider 返回的通用 errorText</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>rate-limit、overloaded、billing 等都走同一条路径。</td>
                </tr>
                <tr>
                  <td>单次工具调用失败警告(⚠️ TOOL failed)</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>最后一次工具错误的汇总提示。</td>
                </tr>
                <tr>
                  <td>Agent runner:API rate-limit / overloaded</td>
                  <td>reply payload isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>auto-reply 路径下的限流友好提示。</td>
                </tr>
                <tr>
                  <td>ACP 分发目标 runtime stale</td>
                  <td>final delivery isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>由 <code>formatAcpRuntimeErrorText</code> 生成。</td>
                </tr>
                <tr>
                  <td>ACP 回合整体失败</td>
                  <td>final delivery isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>ACP 分发 catch 分支:<code>ACP_TURN_FAILED</code>。</td>
                </tr>
                <tr>
                  <td><code>/btw</code> 命令抛出异常</td>
                  <td>reply isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td>命令处理兜底,文本 "⚠️ /btw failed…"。</td>
                </tr>
                <tr>
                  <td>MCP 频道工具:conversation / message 找不到</td>
                  <td>tool call result isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td><code>src/mcp/channel-tools.ts</code>。</td>
                </tr>
                <tr>
                  <td>MCP 插件 server:调用未知工具 / 工具抛异常</td>
                  <td>tool call result isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td><code>src/mcp/plugin-tools-serve.ts</code>。</td>
                </tr>
                <tr>
                  <td>Gateway MCP HTTP:tools/call 未知工具 / 执行异常</td>
                  <td>JSON-RPC result isError: true</td>
                  <td><span class="pm-term-tag pm-term-tag--tool">tool</span></td>
                  <td><code>src/gateway/mcp-http.handlers.ts</code>。</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="pm-term-para" style="margin-top:8px;">
            所以 provider 原生错误(HTTP 500、鉴权失败、RESOURCE_EXHAUSTED 等)不会直接进错误率 ——
            它们要先被 OpenClaw 映射成上表里的某一类信号,再参与 Error Rate 的计算。
          </p>`,
      },
    ],
  },
  {
    title: "序列图 Columns",
    intro: "每一列代表 message 流中的一个参与方。",
    terms: [
      {
        term: "Operator (STA)",
        definition: html`人类用户的设备(手机、笔记本)。扮演 Wi-Fi 中 <em>station</em>(STA)的角色,向
          gateway 发起连接。`,
      },
      {
        term: "Gateway (AP)",
        definition: html`本地的 OpenClaw gateway 进程。扮演 Wi-Fi 中
          <em>access point</em>(AP)的角色,在 operator、node 和 agent 之间转发 message。`,
      },
      {
        term: "Node (PC)",
        definition: html`运行 OpenClaw node 的机器(通常是 PC 或工作站),负责执行 tool、 运行
        sandbox,并为 agent 提供本地资源。`,
      },
      {
        term: "Agent (AP)",
        definition: html`驱动 model loop 的 agent 进程,负责发起 tool call 并把 assistant
        的流式输出回传。它在 gateway 背后,也扮演 AP 的角色。`,
      },
      {
        term: "Model",
        definition: html`上游的 LLM provider(Anthropic、OpenAI 等),agent 通过 HTTP/SSE 调用它来生成
        assistant 的回复。`,
      },
    ],
  },
  {
    title: "Protocol Badges",
    intro: "每条 message 上的 badge 表示它是用哪种 transport 传递的。",
    terms: [
      {
        term: "HTTP/SSE",
        definition: html`HTTP 请求,响应是 Server-Sent Events 流。用于 agent → model 的推理 调用;SSE
        流再经 WebSocket 转发回 UI。`,
      },
      {
        term: "WS/RPC",
        definition: html`承载在 WebSocket 上的 request-response RPC(一次请求,一次对应的响应)。`,
      },
      {
        term: "WS/Event",
        definition: html`通过 WebSocket 的一次 fire-and-forget 广播事件 —— 不期待响应。`,
      },
      {
        term: "WS/Stream",
        definition: html`属于同一个逻辑操作的一串 WebSocket 事件流(例如 assistant 的 token 级输出)。`,
      },
      {
        term: "IPC",
        definition: html`agent 与 gateway 同机部署时,两者之间的进程内 / 进程间通信,不走网络。`,
      },
    ],
  },
  {
    title: "网络统计",
    intro: "沿每条路径测量的方向性 throughput,单位是 bytes / 秒。",
    terms: [
      {
        term: "STA → AP / AP → STA",
        definition: html`operator 设备(station)与 gateway(access point)之间的流量。 STA → AP
        是用户侧上行;AP → STA 是到用户的下行。`,
      },
      {
        term: "AP → PC / PC → AP",
        definition: html`gateway(AP)与 node(PC)之间的流量。承载 tool 下发、文件传输 以及 node
        的状态事件。`,
      },
      {
        term: "Prompt (lifecycle) / Response (stream)",
        definition: html`在 agent ↔ model 这条路径上:<em>prompt</em> 侧是一次性上送的 lifecycle
          payload(system prompt、transcript、tool schema); <em>response</em> 侧是流式回来的
          assistant 输出。`,
      },
      {
        term: "In / Out",
        definition: html`gateway 在观测窗口内所有路径上的总接收字节(In)与总发送字节(Out)。`,
      },
    ],
  },
  {
    title: "图片 Token(Image Tokenization)",
    intro:
      "对话里带图片时,provider 会先把图片按自己的规则切块再按 token 计费。下面这几条说明了两类主流算法、detail 参数,以及 2026-04-16 实测验证过的常量 —— 所有公式都对得上 OpenAI API 实际返回的 prompt_tokens。",
    terms: [
      {
        term: "分块算法(tile-based)",
        definition: html`gpt-4o / gpt-4.1 / gpt-5 / o1 / o3 / computer-use-preview 这一大家族用的算法。流程是:
          <ol class="pm-term-list-inline">
            <li>若最长边 &gt; 2048,等比缩小塞进 <code>2048×2048</code> 外框;</li>
            <li>若短边 &gt; 768,把短边压到 768(长边跟着等比缩);</li>
            <li>按 <code>512×512</code> 切方块(不满一格按一格算);</li>
            <li>收费 = <code>base + tiles × per_tile</code>。</li>
          </ol>
          <div class="pm-term-subheading">各模型的常数</div>
          <ul class="pm-term-list-inline">
            <li>gpt-5 / gpt-5-chat-latest:<code>base = 70</code>,<code>per_tile = 140</code>。</li>
            <li>gpt-4o / gpt-4.1 / gpt-4.5:<code>base = 85</code>,<code>per_tile = 170</code>。</li>
            <li>
              gpt-4o-mini(极贵):<code>base = 2833</code>,<code>per_tile = 5667</code> ——
              注意这组数比主力模型贵 30 倍以上,因为要匹配其廉价的 text token 单价。
            </li>
            <li>o1 / o1-pro / o3:<code>base = 75</code>,<code>per_tile = 150</code>。</li>
            <li>computer-use-preview:<code>base = 65</code>,<code>per_tile = 129</code>。</li>
          </ul>
          <div class="pm-term-example">
            <div class="pm-term-example-label">例</div>
            <div>
              一张 1920×1280 的图,在 gpt-5 上短边 1280 &gt; 768,按比例缩到 <code>1152×768</code>;
              切方块得 <code>⌈1152/512⌉ × ⌈768/512⌉ = 3 × 2 = 6</code> 块;
              tokens = <code>70 + 6 × 140 = 910</code>。实测 API 返回的 image-token 数就是 910。
            </div>
          </div>`,
      },
      {
        term: "分片算法(patch-based)",
        definition: html`gpt-4.1-mini / gpt-4.1-nano / o4-mini 这类"小尺寸"模型用的算法。流程是:
          <ol class="pm-term-list-inline">
            <li>长边超过硬上限(一般 2048)先整体缩;</li>
            <li>
              在图片上铺 <code>32×32</code> 的网格,数出原始 patch 数
              <code>⌈W/32⌉ × ⌈H/32⌉</code>;
            </li>
            <li>
              若超过预算(一般 <code>1536</code> 个 patch),按
              <code>√(budget × 1024 / (W × H))</code> 缩放,然后把尺寸
              <em>向下</em> 对齐到 32 像素网格线,重新数 patch;
            </li>
            <li>
              tokens = <code>round(patches × multiplier)</code> —— 每个模型的
              multiplier 不同,系数越大同图越贵。
            </li>
          </ol>
          <div class="pm-term-subheading">各模型的 multiplier</div>
          <ul class="pm-term-list-inline">
            <li>gpt-4.1-mini:<code>× 1.62</code>。</li>
            <li>gpt-4.1-nano:<code>× 2.46</code>(反而比 mini 贵,因为小模型靠高单价覆盖硬件成本)。</li>
            <li>o4-mini:<code>× 1.72</code>。</li>
          </ul>
          <p class="pm-term-para">
            分片算法 <strong>完全忽略 detail 参数</strong> —— low / high / auto 得到的
            token 数都一样。要省钱只能在 client 侧主动把图缩小。
          </p>`,
      },
      {
        term: "detail 参数(low / high / auto)",
        definition: html`chat completions 里 <code>image_url.detail</code> 字段,只对
          <strong>分块算法</strong> 家族有效。
          <ul class="pm-term-list-inline">
            <li>
              <code>detail: "low"</code> —— 跳过缩放和切块,<em>只</em> 收 <code>base</code>,和原图分辨率
              无关。实测 gpt-5 上无论多大图都固定 70 tokens,适合只需粗略识别内容的场景。
            </li>
            <li>
              <code>detail: "high"</code> / <code>"auto"</code> —— 走完整的
              2048-fit → 768-shortest → 512-tile 流程,按 tile 数计费。
            </li>
            <li>
              <strong>陷阱</strong>:如果图片已经很小(短边 &le; 768),high 和 low
              在 <em>切块那一步</em> 看起来差不多,但 high 仍会按 tile 数累加,low 则只收 base。
              我们实测过:512×341 的图在 gpt-5 上,high = 210 tokens、low = 70 tokens,差 3×。
            </li>
          </ul>
          <p class="pm-term-para">
            <strong>分片算法模型(gpt-4.1-mini / nano、o4-mini)收到 detail 参数时会静默忽略</strong> ——
            不报错,但 cost 没有任何变化。UI 里如果暴露 detail 选项,最好在选到这些模型时禁用或隐藏。
          </p>`,
      },
      {
        term: "128-token 倍数现象",
        definition: html`和 prompt cache 类似,<em>image token 并不一定等于 "完美公式计算出的数"</em> ——
          provider 有时会把结果对齐到 128 的倍数。这在分片算法上尤其明显:一张
          1024×672 的图算下来应该是 <code>32 × 21 × mult ≈ 808</code> tokens,实测也确实是 808;
          但 1536×1009 实测得 1,845,原始 patch 数是 <code>48 × 32 = 1536</code>,乘回去得到
          multiplier ≈ 1.20 而不是文档里说的 1.62。
          <p class="pm-term-para">
            实际工程里别死抠精确公式,把本术语里的数字当作 <em>±5% 以内的估计</em> 来用即可 ——
            真实 API 返回的 <code>prompt_tokens</code> 永远是权威。想做精算时必须发一次真实请求。
          </p>`,
      },
    ],
  },
  {
    title: "Streaming 流式输出",
    intro:
      "把请求设成 stream: true 后,provider 以 Server-Sent Events 增量推送 assistant 输出。下面几条说明了线路上到底在传什么、怎么拿到权威的 token 数、以及怎样正确测生成速度。",
    terms: [
      {
        term: "Delta chunk(增量块)",
        definition: html`每个 SSE event 解出来是一条 <code>chat.completion.chunk</code>。它的
          <code>choices[0].delta.content</code> 只装 <strong>本次新增</strong> 的文本
          —— 不是累积结果。client 必须自己把所有 delta 拼起来才能得到完整回复。
          <ul class="pm-term-list-inline">
            <li>
              <strong>第 1 个 chunk</strong> 通常 <code>content: ""</code> 但带
              <code>role: "assistant"</code>,相当于"开场白"。
            </li>
            <li>
              <strong>中间 chunk</strong> 一条只带几个字符,例如 <code>"A"</code>、
              <code>" golden"</code>、<code>" retriever"</code>……
            </li>
            <li>
              <strong>最后 1 个 content chunk</strong> 的 <code>finish_reason</code> 从
              <code>null</code> 变成 <code>"stop"</code> / <code>"length"</code> 等。
            </li>
            <li>
              每个 chunk 还带一个 <code>obfuscation</code> 字段 —— OpenAI 为了阻断
              BPE 侧信道攻击加的随机 padding,解析时忽略即可。
            </li>
          </ul>
          <p class="pm-term-para">
            所以 OpenClaw 这边如果想把流式输出记录成"当前完整文本",必须维护一个累加 buffer;
            直接把 chunk 存库会拿到一堆碎片。
          </p>`,
      },
      {
        term: "stream_options.include_usage",
        definition: html`<strong>流式请求里拿到权威 token 数的唯一方式。</strong> 默认情况下,流式
          chunk 的 <code>usage</code> 字段从头到尾是 <code>null</code>。把请求参数设成
          <code>stream_options: { include_usage: true }</code> 后,provider 会在正常内容 chunk 之后
          <em>再多发一条特殊 chunk</em>:它的 <code>choices</code> 是空数组,但
          <code>usage</code> 已填充 —— 带 <code>prompt_tokens</code>、
          <code>completion_tokens</code>、<code>total_tokens</code>,以及
          <code>prompt_tokens_details.cached_tokens</code>。
          <div class="pm-term-example">
            <div class="pm-term-example-label">流末尾那条 chunk 的样子</div>
            <div class="pm-explainer-mini">
              { "choices": [],<br />
              &nbsp;&nbsp;"usage": { "prompt_tokens": 29,<br />
              &nbsp;&nbsp;&nbsp;&nbsp;"completion_tokens": 156,<br />
              &nbsp;&nbsp;&nbsp;&nbsp;"total_tokens": 185,<br />
              &nbsp;&nbsp;&nbsp;&nbsp;"prompt_tokens_details": { "cached_tokens": 0 } } }
            </div>
          </div>
          <p class="pm-term-para">
            如果没开 <code>include_usage</code>,流式模式下就 <em>完全拿不到</em> 权威的
            completion_tokens —— 只能按 chunk 数估算(见下文"吞吐率计算")。非流式
            (<code>stream: false</code>)的响应则一直都带 usage,不受此影响。
          </p>`,
      },
      {
        term: "TTFT(Time To First Token)",
        definition: html`从 client 发出请求到收到 <em>第一个 content chunk</em>
          的墙钟耗时。这部分主要是"冷启动 + 网络 RTT + prompt 侧的 prefill",和
          model 实际的稳态生成速率没有直接关系。
          <p class="pm-term-para">
            在报告吞吐率时,<strong>要把 TTFT 和 "后续生成速率" 分开算</strong> ——
            否则短回复会被冷启动延迟严重拖低,显得 model 很慢。推荐两个口径:
          </p>
          <ul class="pm-term-list-inline">
            <li>
              <code>wall_clock_tps = completion_tokens / (t_end − t_request)</code> ——
              带 TTFT,反映终端用户感受。
            </li>
            <li>
              <code>sustained_tps = completion_tokens / (t_end − t_first_chunk)</code> ——
              去掉 TTFT,反映 model 真实的稳态速率。
            </li>
          </ul>
          <p class="pm-term-para">
            实测 gpt-4.1-mini 生成 156 tokens 用了 1,845 ms,TTFT 仅 2 ms(因为连接已热),
            两个口径都得到 ~84.6 tokens/sec。网络差或冷启动时两者可能差 2–5 倍。
          </p>`,
      },
      {
        term: "吞吐率计算(tokens/sec)",
        definition: html`OpenAI 的 SSE <strong>里根本没有任何 tokens/sec 字段</strong> ——
          扫过所有 chunk 也找不到 <code>rate</code> / <code>tps</code> /
          <code>throughput</code> / <code>speed</code> / <code>per_sec</code> 之类。
          想得到吞吐率必须 client 端自己算。两种口径:
          <ul class="pm-term-list-inline">
            <li>
              <strong>权威口径</strong>(推荐)—— 开
              <code>stream_options.include_usage</code>,等末尾那条 chunk 给出
              <code>completion_tokens</code>,除以自己测的 elapsed time。误差只取决于
              <code>time.perf_counter()</code> 精度。
            </li>
            <li>
              <strong>估算口径</strong>(没开 include_usage 时)—— 按收到的 chunk 数除以
              elapsed。实测文本输出平均 ≈ <code>1 token / chunk</code>,但并不严格 1:1:
              某些 chunk 会一次带多个 token(例如 <code>" golden"</code> 是一个 chunk,
              但可能 tokenize 成两个 token)。典型误差 ±1–3%。
            </li>
          </ul>
          <p class="pm-term-para">
            另外 inter-chunk gap <strong>不是均匀的</strong>。实测 gpt-4.1-mini 的 chunk 间隔
            从 0 ms 到 399 ms 都有 —— 模型端经常一次 flush 好几个 token,然后停顿一下。
            所以"最近 1 秒的 chunk 数"这种瞬时速率抖动很大,报告吞吐率必须在整条流上平均。
          </p>`,
      },
    ],
  },
  {
    title: "Prompt Cache 实测补充",
    intro:
      "上面 Usage Overview 里的 Cache 术语讲了三方职责与计费桶的分法。这一组是 2026-04-16 在 OpenAI gpt-4.1 上对 prompt cache 做的专项实测的补充,涵盖了文档里没明说但会在实际调参时撞到的几条规则。",
    terms: [
      {
        term: "前缀哈希路由(前 ~256 tokens)",
        definition: html`OpenAI 的 prompt cache 是 <em>按机器分布</em> 的 —— 不是全局 hash 表。每个请求
          到达时,provider 会对 prompt 的 <strong>前 ~256 tokens</strong> 取哈希,用哈希值挑一台
          特定的 GPU 机器;再在那台机器的显存里查 KV 缓存。
          <p class="pm-term-para">
            推论:
          </p>
          <ul class="pm-term-list-inline">
            <li>
              前 256 tokens 里任何字节变化(例如在 system prompt 里插了时间戳、用户 ID、UUID),
              不仅会 <em>miss</em>,还会把请求 <em>路由到别的机器</em>,连带后面相同的
              前缀也一起冷起步。这比单纯的字节不匹配还糟。
            </li>
            <li>
              所以要想保证命中率,必须让前 256 tokens 完全稳定 —— 典型做法是把 system prompt、
              tool schema、few-shot 示例都写死,避免任何动态拼接。
            </li>
          </ul>`,
      },
      {
        term: "128-token 对齐粒度",
        definition: html`cache 命中数是按 <strong>128-token 的整数倍</strong> 报告的,零头会被
          向下截断。所以 <code>cached_tokens == prompt_tokens</code> 这种"完美命中"几乎看不到。
          <div class="pm-term-example">
            <div class="pm-term-example-label">实测</div>
            <div>
              把一段 1,060 token 的 system prompt 缓存起来,第二次请求的
              <code>prompt_tokens = 1,072</code>,返回的
              <code>cached_tokens = 1,024</code>(= 128 × 8),而不是 1,060 或 1,072。
              剩下那 48 token 被"切掉",按正常 input 计费。
            </div>
          </div>
          <p class="pm-term-para">
            工程上的含义:cache hit rate 永远略低于理论上限。对短 prompt 尤其明显
            (一个 1,200 tokens 的 prompt 只能缓存到 1,152,浪费 48 tokens)。想要最大化命中率,
            静态前缀最好凑到 128 的整数倍。
          </p>`,
      },
      {
        term: "prompt_cache_key 参数",
        definition: html`chat completions 请求里一个可选字符串,会和前缀哈希 <em>合并</em> 成路由键。
          用途是把同一个静态前缀的请求"粘"到同一台机器上。
          <ul class="pm-term-list-inline">
            <li>
              不传:路由只依赖前缀哈希,同前缀的请求会落在同一台机器,命中率高,
              但单机 <strong>~15 RPM 上限</strong> —— 超过就被 fanout 到其它机器,超出部分 miss。
            </li>
            <li>
              传成"per user"(例如 <code>user_id</code>):每用户一条路由,隔离彼此,
              但同一静态前缀会被复制到很多机器,整体命中率略降。
            </li>
            <li>
              传成"per conversation"(例如 <code>session_id</code>):粒度最细,
              对长对话友好,但跨 session 的共用前缀完全不能共享缓存。
            </li>
          </ul>
          <p class="pm-term-para">
            选型原则:让 (前缀, cache_key) 组合的 QPS 落在 ~15 RPM 以下、又尽量少份数。
            高流量场景常见的做法是按 tenant 或 server pod 分桶,而不是按 user 分桶。
          </p>`,
      },
      {
        term: "静态前置 vs 静态后置(实测对比)",
        definition: html`2026-04-16 在 gpt-4.1 上跑了一组对照实验 —— 同一段 ~1,050 tokens 的静态文档,
          改变它在 prompt 里的位置,cache 命中率差异巨大。
          <div class="pm-term-table-wrap">
            <table class="pm-term-table">
              <thead>
                <tr>
                  <th>布局</th>
                  <th>第 2 次请求的 cached_tokens</th>
                  <th>命中率</th>
                  <th>延迟</th>
                  <th>成本 / 千次</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <strong>静态前置</strong> ——
                    静态文档放 system prompt,变化问题放 user message 末尾
                  </td>
                  <td><code>1,024 / 1,072</code></td>
                  <td>95.5%</td>
                  <td>1,070 ms</td>
                  <td>$0.712</td>
                </tr>
                <tr>
                  <td>
                    <strong>静态后置</strong> ——
                    user message 先写变化的 question,再拼上同一段静态文档
                  </td>
                  <td><code>0 / 1,082</code></td>
                  <td>0.0%</td>
                  <td>1,127 ms</td>
                  <td>$2.644</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="pm-term-para">
            两个版本的总 token 数几乎一样,唯一区别是 <em>静态内容的位置</em>。结果:
          </p>
          <ul class="pm-term-list-inline">
            <li>静态前置命中 1,024 / 1,072 = 95.5%;</li>
            <li>静态后置命中 0% —— 因为变化的 question 在前面,前缀一开始就 diverge 了,后面再多的相同内容也救不回来;</li>
            <li>
              成本差了 <strong>3.7×</strong>(每千次 $0.712 vs $2.644),按 100k 次/天的量级推算一年能差 ~$70K USD;
            </li>
            <li>延迟差 5% 左右 —— cache 的钱省得比时间省得明显。</li>
          </ul>
          <p class="pm-term-para">
            工程上的直接结论:<strong>任何按模板展开的长 prompt,变化部分必须塞到末尾</strong>。
            典型反模式是把用户问题拼在 system prompt 头部、或者把日期 / 请求 ID 插进中间 ——
            它们都会让后面几千个静态 token 完全无法缓存。
          </p>`,
      },
    ],
  },
];

export function renderTerminologyPane(): TemplateResult {
  return html`
    <div class="pm-pane pm-terminology-pane">
      <div class="pm-section-title" style="flex-shrink:0;">Terminology</div>
      <p class="pm-muted" style="padding:0 10px 8px;flex-shrink:0;">
        Protocol & Network 页面里用到的术语参考 —— 涵盖 usage 指标、序列图列、protocol badge
        和网络统计。
      </p>
      <div class="pm-terminology-scroll">
        ${TERMINOLOGY_GROUPS.map(
          (group) => html`
            <section class="pm-term-group">
              <h3 class="pm-term-group-title">${group.title}</h3>
              ${group.intro ? html`<p class="pm-term-group-intro">${group.intro}</p>` : nothing}
              <dl class="pm-term-list">
                ${group.terms.map(
                  (t) => html`
                    <div class="pm-term-item">
                      <dt class="pm-term-dt">${t.term}</dt>
                      <dd class="pm-term-dd">${t.definition}</dd>
                    </div>
                  `,
                )}
              </dl>
            </section>
          `,
        )}
      </div>
    </div>
  `;
}
