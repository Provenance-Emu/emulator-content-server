; Original public-domain acceptance program written for this test.
; Battery counter changes palette on A press; pulse audio always active.
; UNIF NROM boards can lack cartridge RAM. The format probe keeps its
; counter in console RAM and does not depend on any cartridge save support.
.ifdef VOLATILE_COUNTER
counter = $01
marker = $02
.else
counter = $6000
marker = $6001
.endif
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
.ifndef VOLATILE_COUNTER
 lda marker
 cmp #$a7
 beq ready
.endif
 lda #1
 sta counter
 lda #$a7
 sta marker
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
 inc counter
palette:
 lda #$3f
 sta $2006
 lda #0
 sta $2006
 lda counter
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
