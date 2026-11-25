	org 00h
ljmp star

org 30h
star:mov r0,#20h
	 mov a,#0ffh
	 mov b,#16
lop1:mov @r0,a
	 inc r0
	 djnz b,lop1
	 sjmp $
	 end