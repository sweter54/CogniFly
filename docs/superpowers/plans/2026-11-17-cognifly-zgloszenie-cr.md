# Zgłoszenie własnych zmian do CR — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Autor zgłasza PR do code review wskazanym osobom z firmy (z Claude i z aplikacji); CogniFly tworzy dla nich zadanie.
**Architecture:** `GET /osoby` + `POST /recenzje` (zdarzenie w historii + zadanie dla recenzentów, bez reguł); CLI `osoby`/`zglos-cr` + sekcja skilla (opcjonalnie `gh pr edit --add-reviewer` po zgodzie); w aplikacji formularz w skrzynce → RPC `review.request`.
**Tech Stack:** jak dotąd.
**Spec:** `docs/superpowers/specs/2026-11-17-cognifly-zgloszenie-cr-design.md`

## Global Constraints
- Recenzenci tylko spośród członków firmy (`OSOBA#`); `opis` z pól strukturalnych; serwer i aplikacja nie piszą do GitHuba.
- `GET /osoby` bez e-maili.
- Nowy kod po angielsku z opisami funkcji; rozszerzane moduły zachowują nazewnictwo. `npm test` zielony; wdrożenie po zgodzie.

## Review Focus
1. Recenzent spoza firmy → `400 ZLI_RECENZENCI`, brak zadania (test API).
2. PR zamknięty / nieistniejący przy dostępnym tokenie → `409 PR_ZAMKNIETY` / `404 BRAK_PR` (test API z atrapą GitHuba).
3. Brak tokenu → zgłoszenie przyjęte bez sprawdzenia PR (test API).
4. Pusta lista recenzentów → `400` (test API i walidacja w aplikacji).
5. Zadanie dla recenzenta otwiera prowadzone CR (`zadanie zad_…` zwraca podmiot repo/pr) — test API.

### Task 1: Serwer — `GET /osoby`, `POST /recenzje`, trasy CDK
### Task 2: Wtyczka — CLI `osoby`, `zglos-cr`, sekcja skilla
### Task 3: Aplikacja — `ApiClient.people/requestReview`, RPC, formularz w skrzynce
### Task 4: Wdrożenie (zgoda), przebudowa aplikacji, test na żywo
