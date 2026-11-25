TEMP EQU 30H
ORG 0000H
JMP START
ORG 0100H

START:
    MOV SP,#5FH
    MOV P0,#8CH      ; 上电显示字符 P
    MOV P3,#0FFH     ; P3作为按键输入，先置1准备读按键
NOKEY:
    MOV A,P3
    CPL A
    JZ NOKEY         ; A=0，说明无按键，继续等待
    MOV TEMP,P3      ; 保存当前P3按键值
    LCALL D10ms      ; 10ms消抖延时
    MOV A,P3
    CJNE A,TEMP,NOKEY; 消抖：两次读取不一样，判定抖动，重新等按键
    
    MOV R7,#16       ; 一共16个数字 0~F
    MOV R2,#0        ; 查表索引初始0
LOOP:
    MOV A,R2
    MOV DPTR,#CODE_P0
    MOVC A,@A+DPTR   ; 查表取段码
    MOV P0,A         ; 送到P0口驱动数码管
    INC R2
    SETB RS0         ; 切换寄存器组（这里单纯演示，本程序没用到换组的寄存器）
    LCALL D_1S       ; 保持显示1秒
    CLR RS0
    DJNZ R7,LOOP     ; 16个没显示完继续
    JMP START        ; 一轮跑完，回到最开始，重新等待按键


;======== 延时子程序 晶振 11.0592MHz ========
D10ms:   ; 延时10ms
    MOV R5,#10
D10_1:
    MOV R6,#200
D10_2:
    DJNZ R6,D10_2
    DJNZ R5,D10_1
    RET

D_1S:    ; 延时1s
    MOV R4,#100
D1S_1:
    LCALL D10ms
    DJNZ R4,D1S_1
    RET

; 共阳极数码管段码表：0 1 2 3 4 5 6 7 8 9 A B C D E F
CODE_P0:
DB 0C0H,0F9H,0A4H,0B0H,99H,92H,82H,0F8H
DB 80H,90H,88H,83H,0C6H,0A1H,86H,8EH
END
