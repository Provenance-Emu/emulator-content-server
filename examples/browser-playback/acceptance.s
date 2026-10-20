; Original public-domain acceptance program written for this test.
; Battery counter changes palette on A press; pulse audio always active.
.segment "HEADER"
.byte $4e,$45,$53,$1a,1,1,$02,0,0,0,0,0,0,0,0,0
.segment "CODE"
reset:
 sei
 cld
 ldx #$ff
 txs
 inx
 stx $2000
 stx $2001
 stx $4010
 bit $2002
wait1: bit $2002
 bpl wait1
wait2: bit $2002
 bpl wait2
 lda $6001
 cmp #$a7
 beq ready
 lda #1
 sta $6000
 lda #$a7
 sta $6001
ready:
 lda #0
 sta $00
 lda #1
 sta $4015
 lda #$bf
 sta $4000
 lda #$fd
 sta $4002
 lda #8
 sta $4003
main:
 bit $2002
wait: bit $2002
 bpl wait
 lda #1
 sta $4016
 lda #0
 sta $4016
 lda $4016
 and #1
 tax
 cmp $00
 beq palette
 stx $00
 cpx #0
 beq palette
 inc $6000
palette:
 lda #$3f
 sta $2006
 lda #0
 sta $2006
 lda $6000
 and #$0f
 ora #$20
 sta $2007
 lda #0
 sta $2006
 sta $2006
 jmp main
irq:
 rti
.segment "VECTORS"
.word irq, reset, irq
.segment "CHARS"
.res 8192,0
