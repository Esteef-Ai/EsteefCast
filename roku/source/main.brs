' EsteefCast for Roku: watch a PC that is sharing with EsteefCast.
sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    screen.CreateScene("MainScene")
    screen.Show()
    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" and msg.IsScreenClosed() then return
    end while
end sub
