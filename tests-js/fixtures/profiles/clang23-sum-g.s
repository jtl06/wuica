	.att_syntax
	.file	"sum.c"
	.text
	.globl	dot                             # -- Begin function dot
	.prefalign	4, .Lfunc_end0, nop
	.type	dot,@function
dot:                                    # @dot
.Lfunc_begin0:
	.file	0 "/src" "sum.c" md5 0x4379ba12fecfc05e8f09849db3bb1891
	.cfi_startproc
# %bb.0:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- $rdx
	#DEBUG_VALUE: dot:s <- 0.000000e+00
	#DEBUG_VALUE: i <- 0
	.loc	0 3 22 prologue_end             # sum.c:3:22
	testq	%rdx, %rdx
.Ltmp0:
	.loc	0 3 3                           # sum.c:3:3
	jle	.LBB0_1
.Ltmp1:
# %bb.2:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- $rdx
	#DEBUG_VALUE: dot:s <- 0.000000e+00
	#DEBUG_VALUE: i <- 0
	movl	%edx, %eax
	andl	$3, %eax
	cmpq	$4, %rdx
	jae	.LBB0_8
.Ltmp2:
# %bb.3:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- $rdx
	#DEBUG_VALUE: dot:s <- 0.000000e+00
	#DEBUG_VALUE: i <- 0
	.loc	0 0 3 is_stmt 0                 # sum.c:0:3
	xorps	%xmm0, %xmm0
	xorl	%ecx, %ecx
	.loc	0 3 3                           # sum.c:3:3
	jmp	.LBB0_5
.Ltmp3:
.LBB0_1:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- $rdx
	#DEBUG_VALUE: dot:s <- 0.000000e+00
	.loc	0 0 3                           # sum.c:0:3
	xorps	%xmm0, %xmm0
	.loc	0 5 3 is_stmt 1                 # sum.c:5:3
	retq
.Ltmp4:
.LBB0_8:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- $rdx
	#DEBUG_VALUE: dot:s <- 0.000000e+00
	#DEBUG_VALUE: i <- 0
	.loc	0 3 3 is_stmt 0                 # sum.c:3:3
	movabsq	$9223372036854775804, %rcx      # imm = 0x7FFFFFFFFFFFFFFC
	andq	%rcx, %rdx
.Ltmp5:
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	.loc	0 0 3                           # sum.c:0:3
	xorps	%xmm0, %xmm0
	xorl	%ecx, %ecx
.Ltmp6:
	.p2align	4
.LBB0_9:                                # =>This Inner Loop Header: Depth=1
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	#DEBUG_VALUE: i <- $rcx
	#DEBUG_VALUE: dot:s <- $xmm0
	.loc	0 4 10 is_stmt 1                # sum.c:4:10
	movss	(%rdi,%rcx,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
.Ltmp7:
	#DEBUG_VALUE: i <- [DW_OP_constu 1, DW_OP_or, DW_OP_stack_value] $rcx
	movss	4(%rdi,%rcx,4), %xmm2           # xmm2 = mem[0],zero,zero,zero
	.loc	0 4 7 is_stmt 0                 # sum.c:4:7
	mulss	(%rsi,%rcx,4), %xmm1
.Ltmp8:
	#DEBUG_VALUE: dot:s <- undef
	.loc	0 4 7 is_stmt 1                 # sum.c:4:7
	mulss	4(%rsi,%rcx,4), %xmm2
	#DEBUG_VALUE: dot:s <- undef
.Ltmp9:
	#DEBUG_VALUE: i <- [DW_OP_constu 2, DW_OP_or, DW_OP_stack_value] $rcx
	.loc	0 4 7                           # sum.c:4:7
	addss	%xmm0, %xmm1
.Ltmp10:
	#DEBUG_VALUE: dot:s <- $xmm1
	.loc	0 4 10 is_stmt 0                # sum.c:4:10
	movss	8(%rdi,%rcx,4), %xmm3           # xmm3 = mem[0],zero,zero,zero
	.loc	0 4 7 is_stmt 1                 # sum.c:4:7
	mulss	8(%rsi,%rcx,4), %xmm3
.Ltmp11:
	#DEBUG_VALUE: dot:s <- undef
	#DEBUG_VALUE: i <- [DW_OP_constu 3, DW_OP_or, DW_OP_stack_value] $rcx
	.loc	0 4 7                           # sum.c:4:7
	addss	%xmm1, %xmm2
.Ltmp12:
	#DEBUG_VALUE: dot:s <- $xmm2
	.loc	0 4 10 is_stmt 0                # sum.c:4:10
	movss	12(%rdi,%rcx,4), %xmm0          # xmm0 = mem[0],zero,zero,zero
	.loc	0 4 7 is_stmt 1                 # sum.c:4:7
	mulss	12(%rsi,%rcx,4), %xmm0
	.loc	0 4 7                           # sum.c:4:7
	addss	%xmm2, %xmm3
.Ltmp13:
	#DEBUG_VALUE: dot:s <- $xmm3
	.loc	0 4 7                           # sum.c:4:7
	addss	%xmm3, %xmm0
.Ltmp14:
	#DEBUG_VALUE: dot:s <- $xmm0
	.loc	0 3 28                          # sum.c:3:28
	addq	$4, %rcx
.Ltmp15:
	#DEBUG_VALUE: i <- $rcx
	.loc	0 3 3                           # sum.c:3:3
	cmpq	%rcx, %rdx
	jne	.LBB0_9
.Ltmp16:
# %bb.4:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	#DEBUG_VALUE: dot:s <- $xmm0
	#DEBUG_VALUE: i <- $rcx
	testq	%rax, %rax
	je	.LBB0_7
.Ltmp17:
.LBB0_5:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- $rsi
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	.loc	0 3 3                           # sum.c:3:3
	leaq	(%rsi,%rcx,4), %rdx
	leaq	(%rdi,%rcx,4), %rcx
	xorl	%esi, %esi
.Ltmp18:
	#DEBUG_VALUE: dot:b <- [DW_OP_LLVM_entry_value 1] $rsi
	.loc	0 0 3 is_stmt 0                 # :0:3
.Ltmp19:
	.p2align	4
.LBB0_6:                                # =>This Inner Loop Header: Depth=1
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- [DW_OP_LLVM_entry_value 1] $rsi
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	#DEBUG_VALUE: i <- [DW_OP_LLVM_arg 0, DW_OP_LLVM_arg 1, DW_OP_plus, DW_OP_stack_value] undef, undef
	#DEBUG_VALUE: dot:s <- $xmm0
	.loc	0 4 10 is_stmt 1                # sum.c:4:10
	movss	(%rcx,%rsi,4), %xmm1            # xmm1 = mem[0],zero,zero,zero
	.loc	0 4 7 is_stmt 0                 # sum.c:4:7
	mulss	(%rdx,%rsi,4), %xmm1
	addss	%xmm1, %xmm0
.Ltmp20:
	#DEBUG_VALUE: dot:s <- $xmm0
	#DEBUG_VALUE: i <- [DW_OP_LLVM_arg 0, DW_OP_consts 1, DW_OP_LLVM_arg 1, DW_OP_plus, DW_OP_plus, DW_OP_stack_value] undef, undef
	.loc	0 3 3 is_stmt 1                 # sum.c:3:3
	incq	%rsi
	cmpq	%rsi, %rax
	jne	.LBB0_6
.Ltmp21:
.LBB0_7:
	#DEBUG_VALUE: dot:a <- $rdi
	#DEBUG_VALUE: dot:b <- [DW_OP_LLVM_entry_value 1] $rsi
	#DEBUG_VALUE: dot:n <- [DW_OP_LLVM_entry_value 1] $rdx
	#DEBUG_VALUE: dot:s <- $xmm0
	.loc	0 5 3                           # sum.c:5:3
	retq
.Ltmp22:
.Lfunc_end0:
	.size	dot, .Lfunc_end0-dot
	.cfi_endproc
                                        # -- End function
	.section	.rodata.cst16,"aM",@progbits,16
	.p2align	4, 0x0                          # -- Begin function count
.LCPI1_0:
	.zero	16,1
	.text
	.globl	count
	.prefalign	4, .Lfunc_end1, nop
	.type	count,@function
count:                                  # @count
.Lfunc_begin1:
	.cfi_startproc
# %bb.0:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	.loc	0 10 22 prologue_end            # sum.c:10:22
	testq	%rsi, %rsi
.Ltmp23:
	.loc	0 10 3                          # sum.c:10:3
	jle	.LBB1_1
.Ltmp24:
# %bb.2:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	cmpq	$4, %rsi
	jae	.LBB1_5
.Ltmp25:
# %bb.3:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	.loc	0 0 3 is_stmt 0                 # sum.c:0:3
	xorl	%ecx, %ecx
	xorl	%eax, %eax
	jmp	.LBB1_4
.Ltmp26:
.LBB1_1:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	xorl	%eax, %eax
	.loc	0 12 3 is_stmt 1                # sum.c:12:3
	retq
.Ltmp27:
.LBB1_5:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	.loc	0 0 3 is_stmt 0                 # sum.c:0:3
	movabsq	$9223372036854775804, %rcx      # imm = 0x7FFFFFFFFFFFFFFC
	andq	%rsi, %rcx
	pxor	%xmm0, %xmm0
	xorl	%eax, %eax
	movdqa	.LCPI1_0(%rip), %xmm3           # xmm3 = [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
	pxor	%xmm2, %xmm2
	pxor	%xmm1, %xmm1
.Ltmp28:
	.p2align	4
.LBB1_6:                                # =>This Inner Loop Header: Depth=1
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	.loc	0 11 10 is_stmt 1               # sum.c:11:10
	movzwl	(%rdi,%rax), %edx
	movd	%edx, %xmm4
	movzwl	2(%rdi,%rax), %edx
	movd	%edx, %xmm5
	.loc	0 11 15 is_stmt 0               # sum.c:11:15
	psrlw	$7, %xmm4
	pand	%xmm3, %xmm4
	psrlw	$7, %xmm5
	pand	%xmm3, %xmm5
	.loc	0 11 10                         # sum.c:11:10
	punpcklbw	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1],xmm4[2],xmm0[2],xmm4[3],xmm0[3],xmm4[4],xmm0[4],xmm4[5],xmm0[5],xmm4[6],xmm0[6],xmm4[7],xmm0[7]
	punpcklwd	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1],xmm4[2],xmm0[2],xmm4[3],xmm0[3]
	punpckldq	%xmm0, %xmm4            # xmm4 = xmm4[0],xmm0[0],xmm4[1],xmm0[1]
	.loc	0 11 7                          # sum.c:11:7
	paddq	%xmm4, %xmm2
	.loc	0 11 10                         # sum.c:11:10
	punpcklbw	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1],xmm5[2],xmm0[2],xmm5[3],xmm0[3],xmm5[4],xmm0[4],xmm5[5],xmm0[5],xmm5[6],xmm0[6],xmm5[7],xmm0[7]
	punpcklwd	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1],xmm5[2],xmm0[2],xmm5[3],xmm0[3]
	punpckldq	%xmm0, %xmm5            # xmm5 = xmm5[0],xmm0[0],xmm5[1],xmm0[1]
	.loc	0 11 7                          # sum.c:11:7
	paddq	%xmm5, %xmm1
	.loc	0 10 28 is_stmt 1               # sum.c:10:28
	addq	$4, %rax
.Ltmp29:
	.loc	0 10 3                          # sum.c:10:3
	cmpq	%rax, %rcx
	jne	.LBB1_6
.Ltmp30:
# %bb.7:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: count:c <- 0
	#DEBUG_VALUE: i <- 0
	.loc	0 10 3                          # sum.c:10:3
	paddq	%xmm2, %xmm1
	pshufd	$238, %xmm1, %xmm0              # xmm0 = xmm1[2,3,2,3]
	paddq	%xmm1, %xmm0
	movq	%xmm0, %rax
	jmp	.LBB1_8
.Ltmp31:
.LBB1_4:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	#DEBUG_VALUE: i <- $rcx
	#DEBUG_VALUE: count:c <- $rax
	.loc	0 11 10                         # sum.c:11:10
	movzbl	(%rdi,%rcx), %edx
	.loc	0 11 15 is_stmt 0               # sum.c:11:15
	shrl	$7, %edx
	.loc	0 11 7                          # sum.c:11:7
	addq	%rdx, %rax
.Ltmp32:
	#DEBUG_VALUE: count:c <- $rax
	.loc	0 10 28 is_stmt 1               # sum.c:10:28
	incq	%rcx
.Ltmp33:
	#DEBUG_VALUE: i <- $rcx
.LBB1_8:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	.loc	0 10 0                          # sum.c:10
	cmpq	%rcx, %rsi
	.loc	0 10 3                          # sum.c:10:3
	jne	.LBB1_4
.Ltmp34:
# %bb.9:
	#DEBUG_VALUE: count:p <- $rdi
	#DEBUG_VALUE: count:n <- $rsi
	.loc	0 12 3                          # sum.c:12:3
	retq
.Ltmp35:
.Lfunc_end1:
	.size	count, .Lfunc_end1-count
	.cfi_endproc
                                        # -- End function
	.section	.debug_loclists,"",@progbits
	.long	.Ldebug_list_header_end0-.Ldebug_list_header_start0 # Length
.Ldebug_list_header_start0:
	.short	5                               # Version
	.byte	8                               # Address size
	.byte	0                               # Segment selector size
	.long	6                               # Offset entry count
.Lloclists_table_base0:
	.long	.Ldebug_loc0-.Lloclists_table_base0
	.long	.Ldebug_loc1-.Lloclists_table_base0
	.long	.Ldebug_loc2-.Lloclists_table_base0
	.long	.Ldebug_loc3-.Lloclists_table_base0
	.long	.Ldebug_loc4-.Lloclists_table_base0
	.long	.Ldebug_loc5-.Lloclists_table_base0
.Ldebug_loc0:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp18-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	84                              # DW_OP_reg4
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp18-.Lfunc_begin0          #   starting offset
	.uleb128 .Lfunc_end0-.Lfunc_begin0      #   ending offset
	.byte	4                               # Loc expr size
	.byte	163                             # DW_OP_entry_value
	.byte	1                               # 1
	.byte	84                              # DW_OP_reg4
	.byte	159                             # DW_OP_stack_value
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_loc1:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp5-.Lfunc_begin0           #   ending offset
	.byte	1                               # Loc expr size
	.byte	81                              # DW_OP_reg1
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp5-.Lfunc_begin0           #   starting offset
	.uleb128 .Lfunc_end0-.Lfunc_begin0      #   ending offset
	.byte	4                               # Loc expr size
	.byte	163                             # DW_OP_entry_value
	.byte	1                               # 1
	.byte	81                              # DW_OP_reg1
	.byte	159                             # DW_OP_stack_value
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_loc2:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp6-.Lfunc_begin0           #   ending offset
	.byte	6                               # Loc expr size
	.byte	158                             # DW_OP_implicit_value
	.byte	4                               # 4
	.byte	0                               #  
	.byte	0                               #  
	.byte	0                               #  
	.byte	0                               #  
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp6-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp8-.Lfunc_begin0           #   ending offset
	.byte	1                               # Loc expr size
	.byte	97                              # DW_OP_reg17
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp10-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp11-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	98                              # DW_OP_reg18
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp12-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp13-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	99                              # DW_OP_reg19
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp13-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp14-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	100                             # DW_OP_reg20
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp14-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp17-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	97                              # DW_OP_reg17
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp18-.Lfunc_begin0          #   starting offset
	.uleb128 .Lfunc_end0-.Lfunc_begin0      #   ending offset
	.byte	1                               # Loc expr size
	.byte	97                              # DW_OP_reg17
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_loc3:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp3-.Lfunc_begin0           #   ending offset
	.byte	3                               # Loc expr size
	.byte	17                              # DW_OP_consts
	.byte	0                               # 0
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp4-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp6-.Lfunc_begin0           #   ending offset
	.byte	3                               # Loc expr size
	.byte	17                              # DW_OP_consts
	.byte	0                               # 0
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp6-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp7-.Lfunc_begin0           #   ending offset
	.byte	1                               # Loc expr size
	.byte	82                              # DW_OP_reg2
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp7-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp9-.Lfunc_begin0           #   ending offset
	.byte	5                               # Loc expr size
	.byte	114                             # DW_OP_breg2
	.byte	0                               # 0
	.byte	49                              # DW_OP_lit1
	.byte	33                              # DW_OP_or
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp9-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp11-.Lfunc_begin0          #   ending offset
	.byte	5                               # Loc expr size
	.byte	114                             # DW_OP_breg2
	.byte	0                               # 0
	.byte	50                              # DW_OP_lit2
	.byte	33                              # DW_OP_or
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp11-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp15-.Lfunc_begin0          #   ending offset
	.byte	5                               # Loc expr size
	.byte	114                             # DW_OP_breg2
	.byte	0                               # 0
	.byte	51                              # DW_OP_lit3
	.byte	33                              # DW_OP_or
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp15-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp17-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	82                              # DW_OP_reg2
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_loc4:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin1-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp31-.Lfunc_begin0          #   ending offset
	.byte	3                               # Loc expr size
	.byte	17                              # DW_OP_consts
	.byte	0                               # 0
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp31-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp33-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	80                              # DW_OP_reg0
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_loc5:
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Lfunc_begin1-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp25-.Lfunc_begin0          #   ending offset
	.byte	3                               # Loc expr size
	.byte	17                              # DW_OP_consts
	.byte	0                               # 0
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp28-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp31-.Lfunc_begin0          #   ending offset
	.byte	3                               # Loc expr size
	.byte	17                              # DW_OP_consts
	.byte	0                               # 0
	.byte	159                             # DW_OP_stack_value
	.byte	4                               # DW_LLE_offset_pair
	.uleb128 .Ltmp31-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp33-.Lfunc_begin0          #   ending offset
	.byte	1                               # Loc expr size
	.byte	82                              # DW_OP_reg2
	.byte	0                               # DW_LLE_end_of_list
.Ldebug_list_header_end0:
	.section	.debug_abbrev,"",@progbits
	.byte	1                               # Abbreviation Code
	.byte	17                              # DW_TAG_compile_unit
	.byte	1                               # DW_CHILDREN_yes
	.byte	37                              # DW_AT_producer
	.byte	37                              # DW_FORM_strx1
	.byte	19                              # DW_AT_language
	.byte	5                               # DW_FORM_data2
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	114                             # DW_AT_str_offsets_base
	.byte	23                              # DW_FORM_sec_offset
	.byte	16                              # DW_AT_stmt_list
	.byte	23                              # DW_FORM_sec_offset
	.byte	27                              # DW_AT_comp_dir
	.byte	37                              # DW_FORM_strx1
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	115                             # DW_AT_addr_base
	.byte	23                              # DW_FORM_sec_offset
	.byte	116                             # DW_AT_rnglists_base
	.byte	23                              # DW_FORM_sec_offset
	.ascii	"\214\001"                      # DW_AT_loclists_base
	.byte	23                              # DW_FORM_sec_offset
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	2                               # Abbreviation Code
	.byte	46                              # DW_TAG_subprogram
	.byte	1                               # DW_CHILDREN_yes
	.byte	17                              # DW_AT_low_pc
	.byte	27                              # DW_FORM_addrx
	.byte	18                              # DW_AT_high_pc
	.byte	6                               # DW_FORM_data4
	.byte	64                              # DW_AT_frame_base
	.byte	24                              # DW_FORM_exprloc
	.byte	122                             # DW_AT_call_all_calls
	.byte	25                              # DW_FORM_flag_present
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	58                              # DW_AT_decl_file
	.byte	11                              # DW_FORM_data1
	.byte	59                              # DW_AT_decl_line
	.byte	11                              # DW_FORM_data1
	.byte	39                              # DW_AT_prototyped
	.byte	25                              # DW_FORM_flag_present
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	63                              # DW_AT_external
	.byte	25                              # DW_FORM_flag_present
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	3                               # Abbreviation Code
	.byte	5                               # DW_TAG_formal_parameter
	.byte	0                               # DW_CHILDREN_no
	.byte	2                               # DW_AT_location
	.byte	24                              # DW_FORM_exprloc
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	58                              # DW_AT_decl_file
	.byte	11                              # DW_FORM_data1
	.byte	59                              # DW_AT_decl_line
	.byte	11                              # DW_FORM_data1
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	4                               # Abbreviation Code
	.byte	5                               # DW_TAG_formal_parameter
	.byte	0                               # DW_CHILDREN_no
	.byte	2                               # DW_AT_location
	.byte	34                              # DW_FORM_loclistx
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	58                              # DW_AT_decl_file
	.byte	11                              # DW_FORM_data1
	.byte	59                              # DW_AT_decl_line
	.byte	11                              # DW_FORM_data1
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	5                               # Abbreviation Code
	.byte	52                              # DW_TAG_variable
	.byte	0                               # DW_CHILDREN_no
	.byte	2                               # DW_AT_location
	.byte	34                              # DW_FORM_loclistx
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	58                              # DW_AT_decl_file
	.byte	11                              # DW_FORM_data1
	.byte	59                              # DW_AT_decl_line
	.byte	11                              # DW_FORM_data1
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	6                               # Abbreviation Code
	.byte	11                              # DW_TAG_lexical_block
	.byte	1                               # DW_CHILDREN_yes
	.byte	85                              # DW_AT_ranges
	.byte	35                              # DW_FORM_rnglistx
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	7                               # Abbreviation Code
	.byte	36                              # DW_TAG_base_type
	.byte	0                               # DW_CHILDREN_no
	.byte	3                               # DW_AT_name
	.byte	37                              # DW_FORM_strx1
	.byte	62                              # DW_AT_encoding
	.byte	11                              # DW_FORM_data1
	.byte	11                              # DW_AT_byte_size
	.byte	11                              # DW_FORM_data1
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	8                               # Abbreviation Code
	.byte	15                              # DW_TAG_pointer_type
	.byte	0                               # DW_CHILDREN_no
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	9                               # Abbreviation Code
	.byte	38                              # DW_TAG_const_type
	.byte	0                               # DW_CHILDREN_no
	.byte	73                              # DW_AT_type
	.byte	19                              # DW_FORM_ref4
	.byte	0                               # EOM(1)
	.byte	0                               # EOM(2)
	.byte	0                               # EOM(3)
	.section	.debug_info,"",@progbits
.Lcu_begin0:
	.long	.Ldebug_info_end0-.Ldebug_info_start0 # Length of Unit
.Ldebug_info_start0:
	.short	5                               # DWARF version number
	.byte	1                               # DWARF Unit Type
	.byte	8                               # Address Size (in bytes)
	.long	.debug_abbrev                   # Offset Into Abbrev. Section
	.byte	1                               # Abbrev [1] 0xc:0xba DW_TAG_compile_unit
	.byte	0                               # DW_AT_producer
	.short	29                              # DW_AT_language
	.byte	1                               # DW_AT_name
	.long	.Lstr_offsets_base0             # DW_AT_str_offsets_base
	.long	.Lline_table_start0             # DW_AT_stmt_list
	.byte	2                               # DW_AT_comp_dir
	.byte	0                               # DW_AT_low_pc
	.long	.Lfunc_end1-.Lfunc_begin0       # DW_AT_high_pc
	.long	.Laddr_table_base0              # DW_AT_addr_base
	.long	.Lrnglists_table_base0          # DW_AT_rnglists_base
	.long	.Lloclists_table_base0          # DW_AT_loclists_base
	.byte	2                               # Abbrev [2] 0x2b:0x41 DW_TAG_subprogram
	.byte	0                               # DW_AT_low_pc
	.long	.Lfunc_end0-.Lfunc_begin0       # DW_AT_high_pc
	.byte	1                               # DW_AT_frame_base
	.byte	87
                                        # DW_AT_call_all_calls
	.byte	3                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	1                               # DW_AT_decl_line
                                        # DW_AT_prototyped
	.long	165                             # DW_AT_type
                                        # DW_AT_external
	.byte	3                               # Abbrev [3] 0x3a:0xa DW_TAG_formal_parameter
	.byte	1                               # DW_AT_location
	.byte	85
	.byte	7                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	1                               # DW_AT_decl_line
	.long	173                             # DW_AT_type
	.byte	4                               # Abbrev [4] 0x44:0x9 DW_TAG_formal_parameter
	.byte	0                               # DW_AT_location
	.byte	8                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	1                               # DW_AT_decl_line
	.long	173                             # DW_AT_type
	.byte	4                               # Abbrev [4] 0x4d:0x9 DW_TAG_formal_parameter
	.byte	1                               # DW_AT_location
	.byte	9                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	1                               # DW_AT_decl_line
	.long	169                             # DW_AT_type
	.byte	5                               # Abbrev [5] 0x56:0x9 DW_TAG_variable
	.byte	2                               # DW_AT_location
	.byte	10                              # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	2                               # DW_AT_decl_line
	.long	165                             # DW_AT_type
	.byte	6                               # Abbrev [6] 0x5f:0xc DW_TAG_lexical_block
	.byte	0                               # DW_AT_ranges
	.byte	5                               # Abbrev [5] 0x61:0x9 DW_TAG_variable
	.byte	3                               # DW_AT_location
	.byte	11                              # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	3                               # DW_AT_decl_line
	.long	169                             # DW_AT_type
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	2                               # Abbrev [2] 0x6c:0x39 DW_TAG_subprogram
	.byte	1                               # DW_AT_low_pc
	.long	.Lfunc_end1-.Lfunc_begin1       # DW_AT_high_pc
	.byte	1                               # DW_AT_frame_base
	.byte	87
                                        # DW_AT_call_all_calls
	.byte	5                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	8                               # DW_AT_decl_line
                                        # DW_AT_prototyped
	.long	169                             # DW_AT_type
                                        # DW_AT_external
	.byte	3                               # Abbrev [3] 0x7b:0xa DW_TAG_formal_parameter
	.byte	1                               # DW_AT_location
	.byte	85
	.byte	12                              # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	8                               # DW_AT_decl_line
	.long	183                             # DW_AT_type
	.byte	3                               # Abbrev [3] 0x85:0xa DW_TAG_formal_parameter
	.byte	1                               # DW_AT_location
	.byte	84
	.byte	9                               # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	8                               # DW_AT_decl_line
	.long	169                             # DW_AT_type
	.byte	5                               # Abbrev [5] 0x8f:0x9 DW_TAG_variable
	.byte	4                               # DW_AT_location
	.byte	14                              # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	9                               # DW_AT_decl_line
	.long	169                             # DW_AT_type
	.byte	6                               # Abbrev [6] 0x98:0xc DW_TAG_lexical_block
	.byte	1                               # DW_AT_ranges
	.byte	5                               # Abbrev [5] 0x9a:0x9 DW_TAG_variable
	.byte	5                               # DW_AT_location
	.byte	11                              # DW_AT_name
	.byte	0                               # DW_AT_decl_file
	.byte	10                              # DW_AT_decl_line
	.long	169                             # DW_AT_type
	.byte	0                               # End Of Children Mark
	.byte	0                               # End Of Children Mark
	.byte	7                               # Abbrev [7] 0xa5:0x4 DW_TAG_base_type
	.byte	4                               # DW_AT_name
	.byte	4                               # DW_AT_encoding
	.byte	4                               # DW_AT_byte_size
	.byte	7                               # Abbrev [7] 0xa9:0x4 DW_TAG_base_type
	.byte	6                               # DW_AT_name
	.byte	5                               # DW_AT_encoding
	.byte	8                               # DW_AT_byte_size
	.byte	8                               # Abbrev [8] 0xad:0x5 DW_TAG_pointer_type
	.long	178                             # DW_AT_type
	.byte	9                               # Abbrev [9] 0xb2:0x5 DW_TAG_const_type
	.long	165                             # DW_AT_type
	.byte	8                               # Abbrev [8] 0xb7:0x5 DW_TAG_pointer_type
	.long	188                             # DW_AT_type
	.byte	9                               # Abbrev [9] 0xbc:0x5 DW_TAG_const_type
	.long	193                             # DW_AT_type
	.byte	7                               # Abbrev [7] 0xc1:0x4 DW_TAG_base_type
	.byte	13                              # DW_AT_name
	.byte	8                               # DW_AT_encoding
	.byte	1                               # DW_AT_byte_size
	.byte	0                               # End Of Children Mark
.Ldebug_info_end0:
	.section	.debug_rnglists,"",@progbits
	.long	.Ldebug_list_header_end1-.Ldebug_list_header_start1 # Length
.Ldebug_list_header_start1:
	.short	5                               # Version
	.byte	8                               # Address size
	.byte	0                               # Segment selector size
	.long	2                               # Offset entry count
.Lrnglists_table_base0:
	.long	.Ldebug_ranges0-.Lrnglists_table_base0
	.long	.Ldebug_ranges1-.Lrnglists_table_base0
.Ldebug_ranges0:
	.byte	4                               # DW_RLE_offset_pair
	.uleb128 .Lfunc_begin0-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp3-.Lfunc_begin0           #   ending offset
	.byte	4                               # DW_RLE_offset_pair
	.uleb128 .Ltmp4-.Lfunc_begin0           #   starting offset
	.uleb128 .Ltmp21-.Lfunc_begin0          #   ending offset
	.byte	0                               # DW_RLE_end_of_list
.Ldebug_ranges1:
	.byte	4                               # DW_RLE_offset_pair
	.uleb128 .Lfunc_begin1-.Lfunc_begin0    #   starting offset
	.uleb128 .Ltmp25-.Lfunc_begin0          #   ending offset
	.byte	4                               # DW_RLE_offset_pair
	.uleb128 .Ltmp28-.Lfunc_begin0          #   starting offset
	.uleb128 .Ltmp34-.Lfunc_begin0          #   ending offset
	.byte	0                               # DW_RLE_end_of_list
.Ldebug_list_header_end1:
	.section	.debug_str_offsets,"",@progbits
	.long	64                              # Length of String Offsets Set
	.short	5
	.short	0
.Lstr_offsets_base0:
	.section	.debug_str,"MS",@progbits,1
.Linfo_string0:
	.asciz	"Homebrew clang version 23.1.6" # string offset=0 ; Homebrew clang version 23.1.6
.Linfo_string1:
	.asciz	"sum.c"                         # string offset=30 ; sum.c
.Linfo_string2:
	.asciz	"/src"                          # string offset=36 ; /src
.Linfo_string3:
	.asciz	"dot"                           # string offset=41 ; dot
.Linfo_string4:
	.asciz	"float"                         # string offset=45 ; float
.Linfo_string5:
	.asciz	"count"                         # string offset=51 ; count
.Linfo_string6:
	.asciz	"long"                          # string offset=57 ; long
.Linfo_string7:
	.asciz	"a"                             # string offset=62 ; a
.Linfo_string8:
	.asciz	"b"                             # string offset=64 ; b
.Linfo_string9:
	.asciz	"n"                             # string offset=66 ; n
.Linfo_string10:
	.asciz	"s"                             # string offset=68 ; s
.Linfo_string11:
	.asciz	"i"                             # string offset=70 ; i
.Linfo_string12:
	.asciz	"p"                             # string offset=72 ; p
.Linfo_string13:
	.asciz	"unsigned char"                 # string offset=74 ; unsigned char
.Linfo_string14:
	.asciz	"c"                             # string offset=88 ; c
	.section	.debug_str_offsets,"",@progbits
	.long	.Linfo_string0
	.long	.Linfo_string1
	.long	.Linfo_string2
	.long	.Linfo_string3
	.long	.Linfo_string4
	.long	.Linfo_string5
	.long	.Linfo_string6
	.long	.Linfo_string7
	.long	.Linfo_string8
	.long	.Linfo_string9
	.long	.Linfo_string10
	.long	.Linfo_string11
	.long	.Linfo_string12
	.long	.Linfo_string13
	.long	.Linfo_string14
	.section	.debug_addr,"",@progbits
	.long	.Ldebug_addr_end0-.Ldebug_addr_start0 # Length of contribution
.Ldebug_addr_start0:
	.short	5                               # DWARF version number
	.byte	8                               # Address size
	.byte	0                               # Segment selector size
.Laddr_table_base0:
	.quad	.Lfunc_begin0
	.quad	.Lfunc_begin1
.Ldebug_addr_end0:
	.ident	"Homebrew clang version 23.1.6"
	.section	".note.GNU-stack","",@progbits
	.addrsig
	.section	.debug_line,"",@progbits
.Lline_table_start0:
