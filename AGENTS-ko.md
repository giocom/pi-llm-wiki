# pi-llm-wiki — 에이전트 지침

> [pi-llm-wiki](https://github.com/giocom/pi-llm-wiki) v0.9 Pi 확장이 설치되어
> 있습니다. 이 파일은 사용법 빠른 참조입니다.
> 원본: <https://github.com/giocom/pi-llm-wiki/blob/master/AGENTS.md>

## 이것은 무엇인가

`pi-llm-wiki`는 Pi용 **로컬 지식 베이스**입니다. (LLM 에이전트인) 당신이
원본 자료(URL이나 파일)를 ingest하고, 현재 Pi 모델로 wiki 글로
compile한 다음, 그 결과를 검색합니다. 허브는 사용자 홈 디렉토리 아래
plain markdown 파일들의 집합일 뿐입니다 — DB도 서버도 없습니다.

**비유**: 원본은 소스 코드, 당신은 컴파일러, wiki는 실행 결과입니다.

## 허브 구조

기본값: `~/wiki/` (`~/.config/llm-wiki/config.json`에서 변경 가능).

```
~/wiki/
├── raw/articles/<slug>/source.md     # immutable 원본 (ingest당 1개)
├── wiki/<slug>/index.md              # LLM-compiled 글 (raw당 1개)
├── raw/articles/_index.md            # ingest/compile 후 자동 갱신
└── wiki/_index.md                    # compile 후 자동 갱신
```

**Slug** = `sha1(정규화된 URL)` 또는 `sha1(절대 파일 경로)`의 앞 12 hex 글자.

**Config** (`~/.config/llm-wiki/config.json`):
```json
{
  "hub_path": "~",          // raw/와 wiki/의 부모 디렉토리
  "default_lang": "ko"      // 선택: "ko", "ja", "en", "zh" — LLM 응답 언어 설정
}
```

## 사용 가능한 도구

확장은 다음 도구들을 등록합니다 (`wiki_<이름>` 형태의 tool call로 사용):

| 도구 | 하는 일 |
|---|---|
| `wiki_ingest` | URL이나 로컬 파일을 `raw/articles/<slug>/source.md`로 추가 |
| `wiki_ls` | 모든 ingested 글 목록을 markdown 표로; `tag` 필터 가능 |
| `wiki_show` | 한 글의 frontmatter + body를 slug로 표시 |
| `wiki_compile` | raw를 LLM 요약해서 `wiki/<slug>/index.md`로 |
| `wiki_query` | grep + LLM 합성 답변을 `path:line` 인용으로 |
| `wiki_lint` | 5개 감사 (frontmatter, wikilink, 빈 파일, 중복, 태그) |
| `wiki_index` | `wiki/_index.md` 표시 또는 `--rebuild` |
| `wiki_search` | (slash 전용) LLM 웹 검색 + 자동 ingest |
| `wiki_add` | ingest + compile 한 번에 |
| `wiki_merge` | 여러 raw를 한 wiki 글로 합치기 |

**슬래시 커맨드** (사용자나 당신이 직접 호출):
- `/wiki:ingest`, `/wiki:ls`, `/wiki:show`, `/wiki:compile`, `/wiki:query`, `/wiki:lint`, `/wiki:index`, `/wiki:search`, `/wiki:add`, `/wiki:merge`

사용자가 `/wiki:ingest <URL>`을 직접 입력할 수도 있습니다 — 당신이
중재할 필요 없음.

## 핵심 원칙

1. **Raw는 immutable.** ingest 후 `raw/articles/<slug>/source.md`를
   수정하지 마세요. 모든 종합은 `wiki/`에서.
2. **Cite-or-skip.** wiki 글의 모든 주장은 `path:line` 인용 필수.
   인용할 수 없으면 그 주장은 버리세요.
3. **기본은 증분.** 사용자가 요청한 것만 compile. 요청 없이 기존
   글을 재compile하지 마세요.
4. **솔직한 공백.** wiki에 답이 없으면 그렇게 말하세요. 채울 자료(URL,
   검색어)를 제안하세요.
5. **`default_lang` 존중.** config에 설정돼 있으면 LLM이 이미 그
   언어로 응답하라고 지시받았습니다. 요청 없이 덮어쓰지 마세요.
6. **Dedup은 자동.** 같은 내용 재ingest는 `duplicate: true` no-op.
   같은 slug에 다른 내용 재ingest는 `--force` 없으면 실패. 확인 없이
   덮어쓰기를 제안하지 마세요.
7. **Hub-aware context.** 매 agent 턴마다 `before_agent_start` 훅이
   매치되는 wiki 발췌 3개까지 시스템 프롬프트에 주입합니다 (매치 없으면
   비용 0). `/wiki:query` 재실행 없이 인용할 수 있습니다.

## 워크플로우

### Ingest

```
/wiki:ingest <URL|경로> [--tags a,b,c] [--force]
```

- URL: 15초 timeout으로 fetch, HTML → turndown으로 markdown 변환,
  YAML frontmatter로 저장 (title, source, url, ingested_at, tags).
- 파일: 그대로 읽어서 같은 frontmatter로 저장.
- Slug는 URL 해시나 파일 경로에서 파생. 같은 출처 → 같은 slug.
- 같은 내용 재ingest: no-op (`duplicate: true`).
- 같은 slug에 다른 내용 재ingest: `--force` 없으면 에러.
- Frontmatter 형식:
  ```yaml
  ---
  title: "..."
  source: "url" | "file"
  url: "..."   (source: url일 때)
  path: "..."  (source: file일 때)
  ingested_at: "2026-07-22T01:54:01.732Z"
  tags: ["a", "b"]
  ---
  ```

### Compile

```
/wiki:compile                # 모든 raw → 모든 wiki
/wiki:compile --topic <slug> # 한 raw → 한 wiki
/wiki:merge --sources a,b [--slug out]  # N raw → 1 merged wiki
```

- 현재 Pi 모델 사용 (`ctx.model`). 모델이 raw body와
  "knowledge-base compiler" 시스템 프롬프트를 보고 종합 글 반환.
- 출력 frontmatter:
  ```yaml
  ---
  title: "..."
  source_slugs: ["<slug>"]
  compiled_at: "2026-07-22T..."
  ---
  ```
- Idempotent: 재실행은 기존 `wiki/<slug>/index.md` 덮어쓰기.
- `runCompile`은 LLM이 빈 요약을 반환하면 (모델 hiccup, rate limit 등)
  명확한 에러로 실패합니다. 다른 모델 시도 또는 `/wiki:show`로 raw
  점검을 권하세요.

### 검색 (LLM 기반)

```
/wiki:search "쿼리" [--limit N]   # slash 전용 — LLM WebSearch + 자동 ingest
```

- LLM의 WebSearch 도구로 N개 URL을 찾아 ingest. Pi에서 WebSearch
  활성화 필요 (예: `OPENCODE_ENABLE_EXA=1`).
- `wiki_search`라는 도구 이름은 없음 (slash만 진입점).

### Query

```
/wiki:query <텍스트> [--tag <이름>] [--max-matches N]
```

- `wiki/`와 `raw/articles/` 둘 다 grep (대소문자 무시, substring).
  매치된 줄을 line 기준 정렬해 상위 N개 (기본 5).
- `tag` 지정 시 해당 태그를 가진 파일만 검색 (wiki 파일은
  `source_slugs`의 태그를 상속).
- 현재 Pi 모델에 합성 프롬프트 호출: "한 문단 답변, 각 비자명한
  주장은 `path:line`으로 인용."
- 합성 답변 + 인용 목록 반환.

### List / Show

```
/wiki:ls [--tag <이름>]
/wiki:show <slug>
```

- `ls`는 모든 ingested 글을 markdown 표로. 태그 필터 시 매치만 표시.
  `raw/articles/_index.md`가 있으면 거기서 읽고, 없으면 디렉토리 직접
  탐색.
- `show`는 한 글의 전체 frontmatter + body. slug 필수 (v0.9에서 fuzzy
  없음).

### Lint

```
/wiki:lint
```

- 모든 `raw/articles/`와 `wiki/` 파일 대상 5개 검사:
  1. **frontmatter** (error) — `---` 누락, 필수 필드 누락
     (title, source, ingested_at)
  2. **wikilinks** (warning) — `[[X]]` 대상이 실제 파일로 안 풀림
  3. **empty** (warning) — 공백만 있는 파일이나 빈 본문
  4. **duplicate** (warning) — raw 파일 두 개의 SHA-1 본문 해시 동일
  5. **tags** (warning / info) — 정규화 안 된 태그 (대소문자, 공백) /
     정규화 후 중복
- 출력: severity별 그룹화 markdown 표.

### Index

```
/wiki:index            # wiki/_index.md 읽기
/wiki:index --rebuild  # 디스크에서 강제 재생성
```

- `wiki:compile`과 `wiki:merge`가 자동 갱신.
- 기본은 읽기 전용; `--rebuild`로 재생성.

## 인덱스

허브의 모든 기존 디렉토리는 내용물을 markdown 표로 보여주는
`_index.md`가 있습니다. 모든 ingest/compile 후 인덱스 자동 갱신.
먼저 인덱스를 읽고, 맨눈으로 스캔하지 마세요.

## 빠른 내비게이션

1. **허브가 처음?** `/wiki:ls`로 뭐가 있는지 보기.
2. **URL 추가?** `/wiki:ingest <URL>` 또는 `/wiki:add <URL>`.
3. **검색 쿼리?** `/wiki:search "용어"` (찾아서 ingest) 또는
   `/wiki:query "용어"` (기존 내용 조회).
4. **여러 raw를 합치기?** `/wiki:merge --sources a,b,c --slug out`.
5. **내용에 대한 질문?** `/wiki:query "질문"`.
6. **뭔가 잘못됐을 때?** `/wiki:lint`.

## 피해야 할 흔한 실수

- **하지 말 것**: ingest 후 `raw/articles/<slug>/source.md` 수정.
  사용자가 정정을 요청하면 wiki 글을 고치지 raw를 고치지 마세요.
- **하지 말 것**: 전부 재compile. 사용자가 명시적으로 요청해야.
  재compile하면 모든 기존 wiki 글이 덮어써집니다.
- **하지 말 것**: `wiki_search` 호출 (그런 도구 없음). `/wiki:search`
  slash를 쓰거나 특정 URL로 `wiki_ingest`를 호출.
- **하지 말 것**: hub 내용이 학습 데이터에 있다고 가정. 인용이
  필요하면 wiki 파일을 직접 읽으세요.
- **하지 말 것**: 사용자가 기억하라고 한 것에 `wiki_ingest`로 raw를
  만듦. 그건 `wiki_query`나 wiki 글의 영역입니다.

## 부팅

이 파일이 세션 시작 시 읽히면, **active wiki identity** 규약을 따르세요:

```
<wiki-name> booted from <wiki-root-path>
```

`hub_path`의 basename 사용 (예: `~/wiki` → `wiki`).

## 참고

- 소스: <https://github.com/giocom/pi-llm-wiki>
- 큰 그림 (참고용): <https://github.com/nvk/llm-wiki/blob/master/AGENTS.md>
- Pi extension 문서: <https://pi.dev/docs/extensions>
