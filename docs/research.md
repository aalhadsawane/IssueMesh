# Research notes

Annotated bibliography for [design.md](design.md). Each entry was checked
against a search result or the source page itself (title, authors, year, URL).
Entries are cited in design.md as [R1], [R2], ...

## Agent cognition

**[R1] Lost in the Middle: How Language Models Use Long Contexts.**
Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua,
Fabio Petroni, Percy Liang. TACL, 2023/2024. https://arxiv.org/abs/2307.03172
Accuracy is highest when relevant information is at the start or end of the
context and drops when it is in the middle, and falls as context grows.
Basis for short status comments and short sessions (PROTOCOL §9.6).

**[R2] Context Rot: How Increasing Input Tokens Impacts LLM Performance.**
Kelly Hong, Anton Troynikov, Jeff Huber (Chroma). 2025.
https://trychroma.com/research/context-rot
Evaluates 18 models; reliability degrades with input length even on simple
tasks. Basis for "one short session per item" (§9.6).

**[R3] Effective context engineering for AI agents.**
Prithvi Rajasekaran, Ethan Dixon, Carly Ryan, Jeremy Hadfield (Anthropic).
2025-09-29.
https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
Names compaction, structured note-taking and sub-agents with clean contexts as
the remedies for finite attention budgets. The status comment is structured
note-taking made shared.

**[R4] Towards Understanding Sycophancy in Language Models.**
Mrinank Sharma, Meg Tong, Ethan Perez, et al. (Anthropic). 2023.
https://arxiv.org/abs/2310.13548
Five assistants show sycophancy; humans and preference models sometimes prefer
convincing sycophantic answers over correct ones. Basis for §9.3.

**[R5] Large Language Models Cannot Self-Correct Reasoning Yet.**
Jie Huang, Xinyun Chen, Swaroop Mishra, Huaixiu Steven Zheng, Adams Wei Yu,
Xinying Song, Denny Zhou. 2023 (ICLR 2024). https://arxiv.org/abs/2310.01798
Without external feedback, self-correction does not help and can hurt. Basis
for receipts (§9.1) and independent review (§9.4).

**[R6] LLM Evaluators Recognize and Favor Their Own Generations.**
Arjun Panickssery, Samuel R. Bowman, Shi Feng. NeurIPS 2024.
https://arxiv.org/abs/2404.13076
Self-recognition correlates with self-preference as a judge. Basis for
different-member, preferably different-runtime, reviewers (§9.4, §7).

**[R7] Encouraging Divergent Thinking in Large Language Models through
Multi-Agent Debate.** Tian Liang, Zhiwei He, Wenxiang Jiao, et al. EMNLP 2024
(arXiv 2023). https://arxiv.org/abs/2305.19118
Names "degeneration-of-thought": once confident, a model stops generating new
ideas even if wrong; also notes an LLM judge may favour the side that shares its
backbone. Basis for steelman and critique before decisions (§9.5).

**[R8] Improving Factuality and Reasoning in Language Models through Multiagent
Debate.** Yilun Du, Shuang Li, Antonio Torralba, Joshua B. Tenenbaum, Igor
Mordatch. ICML 2024 (arXiv 2023). https://arxiv.org/abs/2305.14325
Counter-evidence we take seriously: independent proposals followed by
exchange of reasoning improved accuracy. This is why §9.4 asks for an
independent assessment first and then a comparison, not no interaction.

**[R9] Why Do Multi-Agent LLM Systems Fail?**
Mert Cemri et al. (UC Berkeley). 2025. https://arxiv.org/abs/2503.13657
MAST taxonomy of 14 failure modes in three groups: specification, inter-agent
misalignment, task verification. Motivates explicit specs (DoR), receipts and
verification as protocol rules rather than hoping agents coordinate well.

**[R10] Recent Frontier Models Are Reward Hacking.**
METR. 2025-06-05. https://metr.substack.com/p/2025-06-05-recent-reward-hacking
Frontier models modified tests/scoring code or read existing answers to inflate
scores on METR tasks. Basis for §9.8.

## Multi-agent system design

**[R11] How we built our multi-agent research system.**
Jeremy Hadfield, Barry Zhang, Kenneth Lien, Florian Scholz, Jeremy Fox, Daniel
Ford (Anthropic). 2025-06-13.
https://www.anthropic.com/engineering/multi-agent-research-system
Vague delegation caused duplicated work; subagents need an objective, output
format and boundaries; multi-agent runs use roughly 15x the tokens of chat.
Basis for Definition of Ready and for gating wakes (§6).

**[R12] Don't Build Multi-Agents.**
Walden Yan (Cognition). 2025-06-12. Cognition blog (URL not re-verified in
this environment; cite by title and date).
Parallel agents acting on partial, divergent context make conflicting
decisions. Basis for one owner per issue (claims) and small, bounded issues.

## Distributed systems and engineering practice

**[R13] The Chubby lock service for loosely-coupled distributed systems.**
Mike Burrows. OSDI 2006, pp. 335-350.
https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/
Coarse-grained advisory locks with sessions kept alive by client keep-alives;
used for master election. Model for claim + heartbeat.

**[R14] Leases: An Efficient Fault-Tolerant Mechanism for Distributed File Cache
Consistency.** Cary G. Gray, David R. Cheriton. SOSP 1989, pp. 202-210.
https://courses.cs.duke.edu/spring15/cps210/readings/leases-sosp89.pdf
A lease is a time-limited grant; if the holder fails, the grant simply expires.
Short leases are near-optimal. Also states the clock-skew caveat we inherit.

**[R15] Lazy consensus (ASF glossary).**
The Apache Software Foundation. https://apache.org/foundation/glossary
Consent is presumed if nobody responds within a defined period. Basis for §11.

**[R16] Shape Up: Stop Running in Circles and Ship Work that Matters.**
Ryan Singer (Basecamp). 2019. https://basecamp.com/shapeup
"Appetite": a time budget fixed before design, so scope bends to time.
Basis for the session budget and `size:` cap.

**[R17] Prow command help.**
Kubernetes project. https://prow.k8s.io/command-help
Chat-ops slash commands in issue comments mapped to label changes, with a
generated label reference (kubernetes/test-infra `label_sync/labels.md`).
Model for §2 and §5.
