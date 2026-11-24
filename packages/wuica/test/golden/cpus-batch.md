| File    | Loop  | CPU  | Model     | Year |    TP | Bottlenecks                                                        | Notes       |
|---------|-------|------|-----------|------|------:|--------------------------------------------------------------------|-------------|
| saxpy.s | as is | SKL  | Skylake   | 2015 |  1.50 | Issue, Ports                                                       |             |
|         |       | ZEN3 | AMD Zen 3 | 2020 |  1.00 | Dependencies, Ports                                                | [prototype] |
| a\|b.s  | as is | SKL  | Skylake   | 2015 | 16.00 | Dependencies                                                       |             |
|         |       | ZEN3 | AMD Zen 3 | 2020 | 16.00 | Dependencies                                                       | [prototype] |
| bad.s   | -     |      |           |      |     - | error: assembly failed: line 1: invalid instruction mnemonic 'foo' |             |

TP: cycles per iteration. "-": unknown or failed.\
[prototype]: experimental model of the fork jtl06/uiCA.
