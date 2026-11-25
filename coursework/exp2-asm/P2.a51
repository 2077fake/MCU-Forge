;===== 实验5-2 统计20H~2FH中0的个数，结果存30H =====
FIND_ZERO:
    MOV 30H,#00H    ;计数器先清零
    MOV R0,#20H     ;起始地址20H
    MOV R7,#10H     ;一共16个单元 20H~2FH
FIND_LOOP:
    MOV A,@R0
    JNZ NEXT_UNIT   ;A≠0，跳过计数
    INC 30H         ;A等于0，计数器+1
NEXT_UNIT:
    INC R0
    DJNZ R7,FIND_LOOP
    RET

;======== 测试主程序 ========
ORG 0000H
LJMP MAIN
ORG 0100H
MAIN:
    LCALL FIND_ZERO
    SJMP $
END
