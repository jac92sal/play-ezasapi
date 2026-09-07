' Entry point. Creates the SceneGraph screen and hands control to MainScene.
sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    screen.createScene("MainScene")
    screen.show()

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent" then
            if msg.isScreenClosed() then return
        end if
    end while
end sub
