BUN ?= bun
.PHONY: dev build start install typecheck test ui-smoke check
install:
	$(BUN) install
dev:
	$(BUN) dev
build:
	$(BUN) run build
start:
	$(BUN) start
typecheck:
	$(BUN) run typecheck
test:
	$(BUN) test
ui-smoke:
	$(BUN) run test:ui
check: typecheck test ui-smoke build
