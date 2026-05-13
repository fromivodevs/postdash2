# <System Name>

## Purpose
<1-2 предложения: зачем эта система существует, какую задачу решает>

## Boundaries
**In scope:** <что эта система обязана делать>
**Out of scope:** <что НЕ её ответственность; какая система это делает>

## Main state
<какое состояние держит, где хранится — таблица БД, файл, in-memory cache>

## Module decomposition
Декомпозиция по бизнес-смыслу, не по техническому слою. Каждый модуль — одна ответственность.

- `<module>` — <одна строка ответственности>

## Interface contracts
Публичный API каждого модуля. Сигнатуры с типами.

### `<module>`
- `function_name(arg: Type) -> ReturnType` — что делает, инварианты, ошибки
- `class ClassName` — публичные методы

## Data flow
Текстовая диаграмма с явными передачами и DTO:

```
HTTP request
  → api.endpoint(payload: PayloadDto)
  → service.process(input: ProcessInput) -> Result
    → fetcher.get(url) -> RawData
    → normalizer.parse(raw) -> ParsedItem
  → api.response(result) -> ResponseDto
```

## Dependency graph
Кто кого импортирует. Cycle-warning если есть.

```
api → service → fetcher
       service → normalizer
       service → repo → db
```

## Integration points
Куда система цепляется к существующим (с конкретными именами файлов/таблиц/endpoints):

- Reads `<table>` from <which-system>'s schema (FK to ...)
- Calls `<other-system>.<endpoint>` with header `X-API-Key`
- Subscribes to <event> emitted by <other-system>

## Files
- `<path>` — <role / public API summary>

## Invariants
Что должно быть истинно ВСЕГДА (контракт системы с миром):
- <invariant 1>
- <invariant 2>

## Decision log
Что выбрал, что отверг и почему. Только нетривиальные развилки.

### Decision: <chosen>
**Considered:** <alternatives>
**Chosen:** <choice>
**Why:** <1-2 предложения>
**Tradeoff:** <что теряем>

## How to extend
Конкретная инструкция как добавить новый <thing> внутри системы:
- Новый fetcher: создать `<name>.py`, унаследовать `Fetcher`, реализовать `fetch()`. Зарегистрировать в `<registry>`.

## Status
Active | In design | In progress | Deprecated | Planned

## Last touched
YYYY-MM-DD
