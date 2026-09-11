.PHONY: build install

# Content (PLAYBOOK/contracts) is embedded via go:embed: rebuild after changing the method.
# Mach-O binaries from Go 1.22's internal linker can lack LC_UUID, which dyld rejects; build with the external linker.
build:
	mkdir -p dist/contracts
	cp ../PLAYBOOK.md dist/PLAYBOOK.md
	cp ../contracts/*.json dist/contracts/
	CGO_ENABLED=1 go build -ldflags="-linkmode=external" -o cdp2cli .

install: build
	cp cdp2cli $(HOME)/.local/bin/cdp2cli
	@echo "installed: $(HOME)/.local/bin/cdp2cli"
