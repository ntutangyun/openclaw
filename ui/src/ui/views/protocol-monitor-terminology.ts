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
