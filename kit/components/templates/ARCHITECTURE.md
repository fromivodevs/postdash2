# Architecture

> Оркестратор архитектурных файлов. Каждая система — свой файл
> в `architecture/`. Этот файл — индекс и инструкция как добавлять.

## How to add a new system

1. Скопируй `architecture/_TEMPLATE.md` в `architecture/<system-name>.md`
2. Заполни секции (Purpose, Main state, How it works, Files, Interfaces,
   How to extend, Status, Last touched)
3. Добавь строку ниже в "Active systems"
4. Зафиксируй ссылку из PROJECT_MAP.md (или вызови roadmap-keeper)

## Active systems

- [<system>](architecture/<system>.md) — <one-line purpose>

## Deprecated systems

- (пока пусто)

## Cross-cutting concerns

- Auth: <which system>
- Logging: <which system>
- Configuration: <which system>
