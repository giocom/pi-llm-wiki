# pi-llm-wiki

[Pi](https://pi.dev) 확장으로, [nvk/llm-wiki](https://github.com/nvk/llm-wiki)의
evidence-first 워크플로우를 Pi 런타임에서 사용できるように 합니다. **기능을 하나씩 붙여가며**
빌드되어 — 흐름을 따라가며 배울 수 있습니다. 각 버전은 단 하나의 기능을 추가하며, 패키지는
작게 유지되고 데이터는 로컬 `~/wiki/` 허브에 남습니다.

- English: [README.md](./README.md)
- 참고: [nvk/llm-wiki](https://github.com/nvk/llm-wiki) (커밋 고정)
- 소스: <https://github.com/giocom/pi-llm-wiki>

## 상태

| 버전 | 기능 |
|---|---|
| **v0.4** (현재) | `ingest`, `ls`, `show`, `compile`, `query`, `lint`, `index` + 자동 `_index.md` 갱신 |
| v0.3 | `ingest`/`compile` 후 `raw/articles/_index.md` 자동 재생성 |
| v0.2 | `ls`, `show`, `compile`, `query` |
| v0.1 | `ingest` (URL 또는 로컬 파일) |

모든 버전은 `ingest`와 `compile` 외에는 **기본적으로 읽기 전용**입니다. (`compile`은 허브에 쓰고,
`ingest`도 허브에 씁니다.) `lint`와 `query`는 순수 읽기입니다.

## 하는 일

6개의 슬래시 커맨드와 각각 짝이 되는 LLM 호출 가능 도구:

| 슬래시 | 도구 | 용도 | LLM 호출? |
|---|---|---|---|
| `/wiki:ingest <URL\|경로>` | `wiki_ingest` | 소스를 `raw/articles/<slug>/source.md`로 추가 | ❌ (URL이면 fetch) |
| `/wiki:ls` | `wiki_ls` | 수집된 모든 글 목록 (마크다운 표) | ❌ |
| `/wiki:show <slug>` | `wiki_show` | 한 글의 frontmatter + 본문 표시 | ❌ |
| `/wiki:compile` | `wiki_compile` | raw를 LLM 요약해서 `wiki/<slug>/index.md`로 | ✅ (Pi의 현재 모델 사용) |
| `/wiki:query <텍스트>` | `wiki_query` | grep + LLM이 한 문단 답변으로 합성 | ✅ |
| `/wiki:lint` | `wiki_lint` | 5개 검사 (frontmatter, wikilink, 빈 파일, 중복, 태그) | ❌ |
| `/wiki:index` | `wiki_index` | `wiki/_index.md` 표시 또는 `--rebuild`로 강제 재생성 | ❌ |

## 설치

```bash
pi install git:github.com/giocom/pi-llm-wiki
```

로컬 개발용:

```bash
git clone git@github.com:giocom/pi-llm-wiki.git
cd pi-llm-wiki
npm install
npm run build
pi -e ./src/index.ts
```

## 허브 해석

llm-wiki의 관례를 그대로 따라, Claude Code / Codex / OpenCode / Pi에서 같은 허브를 공유:

1. `~/.config/llm-wiki/config.json` → `hub_path` (`~` 확장 후)
2. `~/wiki` (폴백)

둘 다 없으면 친절한 "No llm-wiki hub found" 메시지를 출력합니다. **자동 생성은 하지 않습니다** —
먼저 허브를 `claude`, `codex`로 만들거나 `mkdir -p ~/wiki/topics/<your-topic>`로 수동 생성하세요.

## 빠른 시작

```bash
# 허브 한 번만 설정
mkdir -p ~/wiki
# 또는: echo '{"hub_path": "~/wiki"}' > ~/.config/llm-wiki/config.json

# Pi 시작
pi -e ./src/index.ts

# 소스 수집
> /wiki:ingest ~/notes/bitcoin-intro.md --tags bitcoin,intro
> /wiki:ingest https://example.com/article --tags web

# 목록 보기
> /wiki:ls

# 하나 보기
> /wiki:show 3a64ff1d4ec2

# 위키 글로 정리 (Pi의 현재 모델 사용)
> /wiki:compile

# 검색 + 답변 합성
> /wiki:query "lightning network"

# 검사 실행
> /wiki:lint

# 위키 인덱스 강제 재생성
> /wiki:index --rebuild
```

## 출력 형식

### `ls` (마크다운 표)

```markdown
| slug | title | source | tags | ingested_at |
|------|-------|--------|------|--------------|
| `3a64ff1d4ec2` | bitcoin-intro.md | file | `bitcoin`, `intro` | 2026-07-22 00:46:14 |
```

### `index` (위키 글, compile 후 자동 생성)

```markdown
| slug | title | source_slugs | compiled_at |
|------|-------|--------------|-------------|
| `03e4ef1aa42f` | note1.md | `03e4ef1aa42f` | 2026-07-22 01:08:23 |
```

### `lint` (severity별 그룹화)

```markdown
## lint report

**Files scanned:** 2  |  **Errors:** 0  |  **Warnings:** 1  |  **Info:** 1

### WARNING (1)
| check | path | line | message |
|-------|------|------|---------|
| wikilink | `raw/articles/3238dd749ace/source.md` | 14 | Broken wikilink: [[bitcoin-basics]] |
```

### `query` (LLM 합성 답변 + `path:line` 인용)

```markdown
Bitcoin is a decentralized digital currency using a public ledger
(raw/articles/3a64ff1d4ec2/source.md:13). The Lightning Network is a
Layer 2 solution (raw/articles/3a64ff1d4ec2/source.md:19).
```

## 아키텍처

```
pi-llm-wiki/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vitest.config.ts
├── src/
│   ├── index.ts          # Pi 셸 — 7개 커맨드, 7개 도구
│   ├── ingest.ts         # v0.1: URL/파일 → raw/articles/<slug>/source.md
│   ├── list.ts           # v0.2: ls, show, parseFrontmatter, raw/wiki 인덱스
│   ├── compile.ts        # v0.2: raw → LLM → wiki/<slug>/index.md
│   ├── query.ts          # v0.2: grep → LLM 합성
│   ├── lint.ts           # v0.4: 5개 감사 검사 + 리포트 포매터
│   ├── llm.ts            # v0.2: Pi AI 래퍼 (complete via ctx.model)
│   └── __tests__/        # 76개 vitest 단위 테스트
└── dist/                 # tsc 빌드 출력
```

`index.ts`만 Pi API에 닿는 파일입니다. 나머지 모듈은 전부 순수 함수이고, 단위 테스트는
밀리초 단위로 끝납니다.

## 개발

```bash
npm install
npm run typecheck    # tsc --noEmit
npm test            # vitest --run (76개 테스트)
npm run build       # tsc -p tsconfig.build.json
npm run check       # typecheck + test
```

### Peer 의존성

확장이 의존하지만 번들하지는 않는 패키지:

- `@earendil-works/pi-coding-agent` — Pi 확장 API
- `@earendil-works/pi-ai` — LLM 전송 (`compile`, `query`에 필요)
- `typebox` — 도구 파라미터 검증을 위한 JSON 스키마

`@earendil-works/pi-ai`는 `compile`과 `query`에만 필요합니다. 나머지 기능
(`ingest`, `ls`, `show`, `lint`, `index`)은 이것 없이도 동작합니다.

## 라이선스

MIT
