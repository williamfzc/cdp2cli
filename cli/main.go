package main

// cdp2cli — methodology reference CLI (globally installed).
// Prints the method, forensic recipes, build SOP and sample contracts for turning
// web-stack desktop apps into CLIs, so agents can read them over a shell without
// accessing the cdp2cli repository. Content is embedded via go:embed: after a
// method upgrade, rebuild and reinstall.

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
)

//go:embed dist/PLAYBOOK.md
var playbook string

//go:embed dist/contracts
var contractsFS embed.FS

const usage = `cdp2cli — web desktop app → CLI conversion method reference

Usage:
  cdp2cli skill [topic]     print the methodology to stdout
  cdp2cli contracts         list embedded sample contracts
  cdp2cli contracts <name>  print a contract's JSON
  cdp2cli help              this help

skill topics:
  all (default)  the full PLAYBOOK (attachment matrix / forensic recipes / contract schema / build SOP / pitfalls & safety)
  attach         runtime detection and CDP attachment
  explore        five-stage loop + copy-paste CDP forensic recipes (endpoint sweep / capture / replay / contracts / DOM)
  contract       the contract schema (how to write contracts/*.json)
  build          build SOP for spinning a standalone CLI off contracts (project layout / lifecycle / command templates / verification loop / build pitfalls)
  safety         known pitfalls and safety notes

Sample contracts come from the ZCode conversion and serve as the format reference for command contracts.
`

func main() {
	args := os.Args[1:]
	cmd := "skill"
	var sub string
	if len(args) > 0 {
		cmd = args[0]
	}
	if len(args) > 1 {
		sub = args[1]
	}

	switch cmd {
	case "help", "-h", "--help":
		fmt.Print(usage)
		os.Exit(0)
	case "skill":
		printSkill(sub)
	case "contracts":
		printContracts(sub)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n%s", cmd, usage)
		os.Exit(1)
	}
}

func printSkill(topic string) {
	switch topic {
	case "", "all":
		fmt.Print(playbook)
	case "attach":
		printSection(playbook, "## 0.", "## 1.")
	case "explore":
		printSection(playbook, "## 1.", "## 2.")
	case "contract":
		printSection(playbook, "## 2.", "## 3.")
	case "build":
		printSection(playbook, "## 3.", "## 4.")
	case "safety":
		printSection(playbook, "## 4.", "## 5.")
	default:
		fmt.Fprintf(os.Stderr, "unknown skill topic: %s (see cdp2cli help)\n", topic)
		os.Exit(1)
	}
}

// printSection prints the lines from the start heading up to, excluding, the next heading.
func printSection(content, start, next string) {
	s := strings.Index(content, start)
	if s < 0 {
		fmt.Fprintf(os.Stderr, "section %s not found\n", start)
		os.Exit(1)
	}
	rest := content[s:]
	if e := strings.Index(rest[len(start):], next); e >= 0 {
		rest = rest[:len(start)+e]
	}
	fmt.Print(rest)
}

func printContracts(name string) {
	entries, err := fs.ReadDir(contractsFS, "dist/contracts")
	if err != nil {
		fmt.Fprintf(os.Stderr, "no contracts embedded: %v\n", err)
		os.Exit(1)
	}
	var names []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			names = append(names, strings.TrimSuffix(e.Name(), ".json"))
		}
	}
	sort.Strings(names)

	if name == "" {
		for _, n := range names {
			fmt.Println(n)
		}
		return
	}
	data, err := contractsFS.ReadFile("dist/contracts/" + name + ".json")
	if err != nil {
		fmt.Fprintf(os.Stderr, "contract not found: %s (list with `cdp2cli contracts`)\n", name)
		os.Exit(1)
	}
	fmt.Println(string(data))
}
