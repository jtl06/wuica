**trace** · 9 uops

| iteration | instruction                      | port   | predecoded | IDQ | issued | ready | dispatched | executed | retired | waited for                                |
|----------:|:---------------------------------|:-------|-----------:|----:|-------:|------:|-----------:|---------:|--------:|:------------------------------------------|
|       123 | add rax, 0x1                     | Port 6 |            | 124 |    163 |   253 |        253 |      255 |     256 | add rax, 0x1 [it 122]                     |
|       123 | add rax, 0x1                     | Port 0 |            | 124 |    163 |   254 |        254 |      256 |     257 | add rax, 0x1 [it 123]                     |
|       123 | dec r15 + jnz 0xfffffffffffffff5 | Port 6 |            | 124 |    163 |   170 |        170 |      172 |     257 | dec r15 + jnz 0xfffffffffffffff5 [it 122] |
|       124 | add rax, 0x1                     | Port 5 |            | 126 |    166 |   255 |        255 |      257 |     258 | add rax, 0x1 [it 123]                     |
|       124 | add rax, 0x1                     | Port 0 |            | 126 |    166 |   256 |        256 |      258 |     259 | add rax, 0x1 [it 124]                     |
|       124 | dec r15 + jnz 0xfffffffffffffff5 | Port 6 |            | 126 |    166 |   172 |        173 |      175 |     259 | dec r15 + jnz 0xfffffffffffffff5 [it 123] |
|       125 | add rax, 0x1                     | Port 0 |            | 128 |    166 |   257 |        257 |      259 |     260 | add rax, 0x1 [it 124]                     |
|       125 | add rax, 0x1                     | Port 6 |            | 128 |    168 |   258 |        258 |      260 |     261 | add rax, 0x1 [it 125]                     |
|       125 | dec r15 + jnz 0xfffffffffffffff5 | Port 6 |            | 128 |    168 |   175 |        175 |      177 |     261 | dec r15 + jnz 0xfffffffffffffff5 [it 124] |
